import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const GITHUB_API = 'https://api.github.com';

const agent = await createAgent({
  name: 'github-dev-intel',
  version: '1.0.0',
  description: 'GitHub intelligence for AI agents - trending repos, releases, stars, and developer activity tracking',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch from GitHub API ===
async function fetchGitHub(path: string): Promise<any> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-dev-intel/1.0 (AI Agent)',
  };
  
  // Use token if available for higher rate limits
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(`${GITHUB_API}${path}`, { headers });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${text.slice(0, 200)}`);
  }
  
  return response.json();
}

// === Format repo data for consistent output ===
function formatRepo(repo: any) {
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login,
    description: repo.description,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.watchers_count,
    openIssues: repo.open_issues_count,
    language: repo.language,
    topics: repo.topics || [],
    license: repo.license?.spdx_id || null,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    defaultBranch: repo.default_branch,
    homepage: repo.homepage || null,
    url: repo.html_url,
    isArchived: repo.archived,
    isFork: repo.fork,
  };
}

// === Serve icon ===
app.get('/icon.png', async (c) => {
  const iconPath = './icon.png';
  if (existsSync(iconPath)) {
    const icon = readFileSync(iconPath);
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' }
    });
  }
  return c.text('Icon not found', 404);
});

// === ERC-8004 Registration File ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://github-dev-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "github-dev-intel",
    description: "GitHub intelligence for AI agents - trending repos, releases, stars tracking. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - see trending repos and agent capabilities',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    // Get a sample of trending repos (recently created with high stars)
    const data = await fetchGitHub('/search/repositories?q=created:>2026-01-24+stars:>100&sort=stars&order=desc&per_page=5');
    
    return {
      output: {
        agent: 'github-dev-intel',
        version: '1.0.0',
        description: 'GitHub intelligence for AI agents',
        dataSource: 'GitHub API (live)',
        sampleTrending: data.items.slice(0, 3).map((r: any) => ({
          name: r.full_name,
          stars: r.stargazers_count,
          language: r.language,
          description: r.description?.slice(0, 100),
        })),
        endpoints: {
          'trending': { price: '$0.001', description: 'Discover trending repos by timeframe/language' },
          'repo-stats': { price: '$0.002', description: 'Detailed stats for a specific repository' },
          'releases': { price: '$0.002', description: 'Recent releases for a repository' },
          'search': { price: '$0.002', description: 'Search repositories with filters' },
          'compare': { price: '$0.005', description: 'Compare multiple repositories side-by-side' }
        },
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 1: Trending Repos ($0.001) ===
addEntrypoint({
  key: 'trending',
  description: 'Discover trending repositories by timeframe and language',
  input: z.object({
    timeframe: z.enum(['day', 'week', 'month']).optional().default('week'),
    language: z.string().optional(),
    limit: z.number().min(1).max(30).optional().default(10),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const { timeframe, language, limit } = ctx.input;
    
    // Calculate date range
    const now = new Date();
    let daysAgo = 7;
    if (timeframe === 'day') daysAgo = 1;
    if (timeframe === 'month') daysAgo = 30;
    
    const since = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const sinceStr = since.toISOString().split('T')[0];
    
    // Build query
    let query = `created:>${sinceStr}+stars:>10`;
    if (language) {
      query += `+language:${encodeURIComponent(language)}`;
    }
    
    const data = await fetchGitHub(`/search/repositories?q=${query}&sort=stars&order=desc&per_page=${limit}`);
    
    return {
      output: {
        timeframe,
        language: language || 'all',
        count: data.items.length,
        totalMatches: data.total_count,
        repos: data.items.map(formatRepo),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: Repo Stats ($0.002) ===
addEntrypoint({
  key: 'repo-stats',
  description: 'Get detailed statistics for a specific repository',
  input: z.object({
    repo: z.string().describe('Full repo name: owner/repo'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { repo } = ctx.input;
    
    // Fetch repo details and contributors in parallel
    const [repoData, contributors, languages] = await Promise.all([
      fetchGitHub(`/repos/${repo}`),
      fetchGitHub(`/repos/${repo}/contributors?per_page=10`).catch(() => []),
      fetchGitHub(`/repos/${repo}/languages`).catch(() => ({})),
    ]);
    
    return {
      output: {
        ...formatRepo(repoData),
        size: repoData.size,
        hasWiki: repoData.has_wiki,
        hasPages: repoData.has_pages,
        hasDownloads: repoData.has_downloads,
        subscribersCount: repoData.subscribers_count,
        networkCount: repoData.network_count,
        languages,
        topContributors: contributors.slice(0, 5).map((c: any) => ({
          login: c.login,
          contributions: c.contributions,
          profileUrl: c.html_url,
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: Releases ($0.002) ===
addEntrypoint({
  key: 'releases',
  description: 'Get recent releases for a repository',
  input: z.object({
    repo: z.string().describe('Full repo name: owner/repo'),
    limit: z.number().min(1).max(30).optional().default(10),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { repo, limit } = ctx.input;
    
    const releases = await fetchGitHub(`/repos/${repo}/releases?per_page=${limit}`);
    
    return {
      output: {
        repo,
        count: releases.length,
        releases: releases.map((r: any) => ({
          tagName: r.tag_name,
          name: r.name,
          isDraft: r.draft,
          isPrerelease: r.prerelease,
          publishedAt: r.published_at,
          author: r.author?.login,
          body: r.body?.slice(0, 500),
          htmlUrl: r.html_url,
          assets: r.assets?.map((a: any) => ({
            name: a.name,
            downloadCount: a.download_count,
            size: a.size,
          })) || [],
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: Search Repos ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search repositories with advanced filters',
  input: z.object({
    query: z.string().describe('Search query'),
    language: z.string().optional(),
    minStars: z.number().optional(),
    sort: z.enum(['stars', 'forks', 'updated', 'help-wanted-issues']).optional().default('stars'),
    limit: z.number().min(1).max(30).optional().default(10),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { query, language, minStars, sort, limit } = ctx.input;
    
    let q = query;
    if (language) q += `+language:${encodeURIComponent(language)}`;
    if (minStars) q += `+stars:>=${minStars}`;
    
    const data = await fetchGitHub(`/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${limit}`);
    
    return {
      output: {
        query,
        filters: { language, minStars, sort },
        count: data.items.length,
        totalMatches: data.total_count,
        repos: data.items.map(formatRepo),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Compare Repos ($0.005) ===
addEntrypoint({
  key: 'compare',
  description: 'Compare multiple repositories side-by-side',
  input: z.object({
    repos: z.array(z.string()).min(2).max(5).describe('Array of repo names: ["owner/repo1", "owner/repo2"]'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const { repos } = ctx.input;
    
    // Fetch all repos in parallel
    const repoDataArray = await Promise.all(
      repos.map(async (repo) => {
        try {
          const [data, languages] = await Promise.all([
            fetchGitHub(`/repos/${repo}`),
            fetchGitHub(`/repos/${repo}/languages`).catch(() => ({})),
          ]);
          return { 
            ...formatRepo(data), 
            languages,
            status: 'success' 
          };
        } catch (e: any) {
          return { 
            fullName: repo, 
            status: 'error', 
            error: e.message 
          };
        }
      })
    );
    
    // Calculate comparison metrics
    const successful = repoDataArray.filter((r: any) => r.status === 'success');
    const comparison = {
      mostStars: successful.reduce((a: any, b: any) => (a.stars > b.stars ? a : b), successful[0])?.fullName,
      mostForks: successful.reduce((a: any, b: any) => (a.forks > b.forks ? a : b), successful[0])?.fullName,
      mostRecent: successful.reduce((a: any, b: any) => 
        new Date(a.pushedAt) > new Date(b.pushedAt) ? a : b, successful[0])?.fullName,
      avgStars: Math.round(successful.reduce((sum: number, r: any) => sum + r.stars, 0) / successful.length),
    };
    
    return {
      output: {
        requestedRepos: repos,
        count: repoDataArray.length,
        repos: repoDataArray,
        comparison,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`github-dev-intel agent running on port ${port}`);

export default { port, fetch: app.fetch };
