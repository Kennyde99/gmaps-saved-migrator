// Values identify an account; passwords, tokens and cookies are never accepted.
export function applyEnvironment(args, env = process.env) {
  const result = { ...args };
  const keys = { 'expected-account': 'GMAPS_TARGET_ACCOUNT', 'target-list': 'GMAPS_TARGET_LIST', profile: 'GMAPS_PROFILE', browser: 'GMAPS_BROWSER' };
  for (const [key, name] of Object.entries(keys)) if (!result[key] && env[name]) result[key] = env[name];
  // --execute, --live, --confirm-account and --dedicated-list-confirm remain explicit.
  return result;
}
