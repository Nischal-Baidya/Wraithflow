const config = window.WRAITHFLOW_CONFIG;

if (!config?.supabaseUrl || !config?.supabasePublishableKey || !window.supabase) {
  throw new Error('WraithFlow could not initialize its public Supabase client configuration.');
}

export const supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { headers: { 'X-Client-Info': `wraithflow/${config.appVersion}` } }
});

export const TABLES = Object.freeze([
  'profiles', 'habits', 'habit_entries', 'goals', 'goal_milestones',
  'planner_tasks', 'journal_entries', 'journal_photos'
]);
