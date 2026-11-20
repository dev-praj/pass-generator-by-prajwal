// Local preview config. Vercel builds replace dist/config.js with the values from Vercel's environment.
// This publishable key is public by design; RLS protects the data. Never use a secret/service_role key here.
window.GATEPASS = {
  supabaseUrl: "https://wzuifjwvpypynkfvqwyx.supabase.co",
  supabasePublishableKey: "sb_publishable_QZzhST0dbcLqjB4EVeMnUA_PTr6ouE6",

  // Organiser sign-in methods.
  // emailSignIn: magic link by email (needs the Email provider on; for more than a few emails an hour, custom SMTP).
  // googleSignIn: "Continue with Google" (needs the Google provider set up in Supabase → Authentication → Providers).
  // The hosted copy uses Google only, because its shared Supabase project has email sign-ups switched off.
  emailSignIn: false,
  googleSignIn: true,
};
