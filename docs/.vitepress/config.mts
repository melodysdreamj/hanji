import { defineConfig } from 'vitepress'

// The docs site builds straight from docs/*.md — the same files linked from
// the README. Deployed to GitHub Pages by .github/workflows/docs.yml.
export default defineConfig({
  title: 'Hanji',
  description:
    'Open-source Notion clone — bring your whole Notion workspace to your own server in one import.',
  base: '/hanji/',
  lastUpdated: true,

  // localhost URLs in the guides are instructions, not site links.
  ignoreDeadLinks: [/^https?:\/\/localhost/, /^https?:\/\/127\.0\.0\.1/],

  // Internal development docs live in this same folder but are excluded from
  // the public git index (see .gitignore). Exclude them here too so a local
  // build never picks them up; the CI build runs from a public checkout where
  // these files do not exist at all.
  srcExclude: [
    'project-operating-loop.md',
    'confirmed-contracts.md',
    'contract-candidates.md',
    'work-ledger.md',
    'notion-reference-loop.md',
    'edgebase-first-roadmap.md',
    'notion-feature-matrix.md',
    'visual-parity-audit.md',
    'license-and-monetization.md',
    'private-repo-setup.md',
    'workspace-do-migration.md',
    'local-first-roadmap.md',
    'native-export-import-plan.md',
  ],

  themeConfig: {
    nav: [
      { text: 'Docker', link: '/docker' },
      { text: 'Guide', link: '/development' },
      { text: 'Deployment', link: '/deployment' },
      { text: 'GitHub', link: 'https://github.com/melodysdreamj/hanji' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Local development', link: '/development' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Verification catalog', link: '/verification' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Docker quick start', link: '/docker' },
          { text: 'Deployment', link: '/deployment' },
          { text: 'Master account', link: '/master-account' },
          { text: 'Cloudflare teardown', link: '/cloudflare-teardown' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Sponsors & banner', link: '/sponsors' },
          { text: 'Icon parity audit', link: '/icon-parity-audit' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/melodysdreamj/hanji' }],
    search: { provider: 'local' },
    footer: {
      message:
        'Independent from and not endorsed by Notion Labs, Inc. AGPL-3.0 with the <a href="https://github.com/melodysdreamj/hanji/blob/main/LICENSE-EXCEPTION">Sponsor Banner Exception 2.0</a>.',
    },
  },
})
