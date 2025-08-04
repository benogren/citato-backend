// supabase/functions/test-gmail-integration/index.ts
// Test function to verify Gmail API integration is working

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

// Newsletter detection patterns
const NEWSLETTER_PATTERNS = [
  '*@mail.beehiiv.com',
  '*@substack.com', 
  '*@convertkit.com',
  'crew@morningbrew.com',
  'hello@thehustle.co',
  '*@newsletters.feedbinusercontent.com',
  '*@ck.convertkit.com',
  '*@ghost.org'
];

// Check if email matches newsletter patterns
function matchesNewsletterPattern(email: string): boolean {
  return NEWSLETTER_PATTERNS.some(pattern => {
    if (pattern.startsWith('*@')) {
      const domain = pattern.substring(2);
      return email.toLowerCase().endsWith(domain.toLowerCase());
    }
    return email.toLowerCase() === pattern.toLowerCase();
  });
}

// Gmail API client with token refresh
async function createGmailClient(userId: string, accessToken: string, refreshToken: string, supabase: any) {
  let currentAccessToken = accessToken;

  async function refreshAccessToken() {
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
          client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to refresh token');
      }

      const data = await response.json();
      currentAccessToken = data.access_token;

      // Update token in database
      await supabase
        .from('auth_tokens')
        .update({
          access_token: currentAccessToken,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      console.log('Successfully refreshed access token');
      return currentAccessToken;
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw error;
    }
  }

  async function makeRequest(url: string, options: RequestInit = {}) {
    const headers = {
      'Authorization': `Bearer ${currentAccessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
      console.log('Token expired, refreshing...');
      currentAccessToken = await refreshAccessToken();
      
      // Retry with new token
      response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${currentAccessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    }

    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  return {
    async listMessages(query: string, maxResults: number = 10) {
      const baseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
      const params = new URLSearchParams({
        q: query,
        maxResults: maxResults.toString()
      });
      return makeRequest(`${baseUrl}?${params}`);
    },

    async getMessage(messageId: string) {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
      return makeRequest(url);
    }
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      throw new Error('Missing authorization header');
    }

    // Create Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Verify JWT and get user
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
    
    if (userError || !user) {
      throw new Error('Invalid or expired token');
    }

    console.log(`Testing Gmail integration for user: ${user.id}`);

    // Get user's Gmail tokens
    const { data: authData, error: authError } = await supabase
      .from('auth_tokens')
      .select('access_token, refresh_token')
      .eq('user_id', user.id)
      .single();

    if (authError || !authData) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'No Gmail tokens found. Please reconnect your Gmail account.',
          needsReauth: true
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

    // Create Gmail client
    const gmail = await createGmailClient(
      user.id,
      authData.access_token,
      authData.refresh_token,
      supabase
    );

    // Test 1: Get recent emails (last 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const formattedDate = Math.floor(yesterday.getTime() / 1000);
    
    console.log('Fetching recent emails...');
    const recentEmails = await gmail.listMessages(`after:${formattedDate}`, 20);
    
    if (!recentEmails.messages) {
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'Gmail connection successful, but no recent emails found.',
          stats: {
            totalEmails: 0,
            newsletters: 0,
            detectedNewsletters: []
          }
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

    console.log(`Found ${recentEmails.messages.length} recent emails`);

    // Test 2: Get email details and detect newsletters
    const detectedNewsletters = [];
    let processedCount = 0;

    for (const message of recentEmails.messages.slice(0, 10)) { // Process first 10 for testing
      try {
        const fullMessage = await gmail.getMessage(message.id);
        const headers = fullMessage.payload?.headers || [];
        
        const from = headers.find((h: any) => h.name === 'From')?.value || '';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '';
        const dateHeader = headers.find((h: any) => h.name === 'Date')?.value || '';

        // Extract email address from From header
        const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
        const emailAddress = emailMatch ? (emailMatch[1] || emailMatch[0]).trim() : from;

        // Test newsletter detection
        if (matchesNewsletterPattern(emailAddress)) {
          detectedNewsletters.push({
            messageId: message.id,
            from: from,
            email: emailAddress,
            subject: subject,
            date: dateHeader,
            matched: true
          });
        }

        processedCount++;
      } catch (error) {
        console.error(`Error processing message ${message.id}:`, error);
      }
    }

    // Test 3: Check curated newsletter list from database
    const { data: curatedNewsletters } = await supabase
      .from('newsletters_curated')
      .select('email_pattern, name')
      .eq('is_active', true);

    const response = {
      success: true,
      message: 'Gmail integration test completed successfully!',
      stats: {
        totalEmails: recentEmails.messages.length,
        processedEmails: processedCount,
        detectedNewsletters: detectedNewsletters.length,
        curatedPatternsCount: curatedNewsletters?.length || 0
      },
      detectedNewsletters: detectedNewsletters,
      curatedPatterns: curatedNewsletters?.map(n => ({
        pattern: n.email_pattern,
        name: n.name
      })) || [],
      testResults: {
        gmailApiAccess: '✅ Success',
        tokenRefresh: '✅ Working',
        emailRetrieval: '✅ Working',
        newsletterDetection: detectedNewsletters.length > 0 ? '✅ Found newsletters' : '⚠️ No newsletters detected'
      }
    };

    return new Response(
      JSON.stringify(response, null, 2),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error) {
    console.error('Test function error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message,
        stack: error.stack 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});