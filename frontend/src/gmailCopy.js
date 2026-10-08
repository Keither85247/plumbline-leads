// User-facing copy for Gmail connection outcomes (shared by EmailPage and
// GmailConnectionView). Keys are the fixed codes the backend returns.
export const GMAIL_ERROR_COPY = {
  access_restricted: {
    title: 'Gmail access is currently limited during beta testing.',
    body:  'Contact your administrator to enable Gmail access for your Google account.',
  },
  oauth_disabled: {
    title: 'Gmail connection is not available yet.',
    body:  'We\'re finishing Google verification before enabling Gmail sync for testers.',
  },
  not_configured: {
    title: 'Gmail is not configured on this server.',
    body:  'Contact your administrator to set up Gmail integration.',
  },
  oauth_cancelled: {
    title: 'Gmail connection was cancelled.',
    body:  'You can try connecting again from Email Settings.',
  },
  oauth_error: {
    title: 'Gmail connection could not be completed.',
    body:  'Contact your administrator if this keeps happening.',
  },
  callback_failed: {
    title: 'Gmail connection could not be completed.',
    body:  'Please try again from Email Settings.',
  },
  state_invalid: {
    title: 'That Gmail connection link expired or was already used.',
    body:  'Start again from Email Settings and tap Connect Gmail.',
  },
  restart_required: {
    title: 'Please start the Gmail connection again.',
    body:  'Open Email Settings and tap Connect Gmail.',
  },
  missing_scopes: {
    title: 'Gmail needs all of the requested permissions.',
    body:  'Connect again and leave every Gmail permission ticked.',
  },
  signed_in_other_account: {
    title: 'This browser is signed in to a different Plumbline Leads account.',
    body:  'Sign out of Plumbline Leads in this browser, then tap Connect Gmail again in the app.',
  },
  account_mismatch: {
    title: 'This Gmail connection was started from a different Plumbline Leads account.',
    body:  'Sign in with the account you used when you tapped Connect Gmail.',
  },
  session_required: {
    title: 'Sign in to Plumbline Leads in this browser first.',
    body:  'Gmail can only be connected from a browser where you are signed in.',
  },
  too_many_attempts: {
    title: 'Too many Gmail connection attempts.',
    body:  'Please wait a few minutes and try again.',
  },
};

export const gmailErrorCopy = (code) => GMAIL_ERROR_COPY[code] || GMAIL_ERROR_COPY.oauth_error;
