// A Cloudflare Worker that starts the "Update rookie list" workflow on a timer,
// because GitHub's own schedule skips most of its runs.
//
// It needs one secret, GITHUB_TOKEN: a fine-grained personal access token limited
// to this repository with "Actions: Read and write". See the README.

const REPO = 'isriah/frc-rookies';
const WORKFLOW = 'update.yml';

export async function trigger(env, fetcher = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN secret is not set');
  const api = env.GITHUB_API || 'https://api.github.com';
  const res = await fetcher(`${api}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'frc-rookies-trigger',
      'Content-Type': 'application/json',
    },
    // "auto" lets the updater decide whether event registrations are due.
    body: JSON.stringify({ ref: 'main', inputs: { events: 'auto' } }),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export default {
  // Throwing marks the run as failed in Cloudflare's logs.
  async scheduled(controller, env) {
    await trigger(env);
    console.log('Workflow started');
  },
};
