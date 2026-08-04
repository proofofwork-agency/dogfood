import type { Config } from "@docusaurus/types"
import type { Options, ThemeConfig } from "@docusaurus/preset-classic"
import { themes as prismThemes } from "prism-react-renderer"

const config: Config = {
  title: "Dogfood",
  tagline: "Proof that an acceptance criterion was met, or a refusal to say so",
  favicon: "img/dogfood-mark.svg",
  url: "https://proofofwork-agency.github.io",
  baseUrl: "/dogfood/",
  organizationName: "proofofwork-agency",
  projectName: "dogfood",
  trailingSlash: false,
  onBrokenLinks: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],
  presets: [
    [
      "classic",
      {
        docs: {
          // The docs/ directory ships in the npm tarball, so the site renders it in place
          // rather than keeping a second copy that would drift from the package.
          path: "../docs",
          sidebarPath: "./sidebars.ts",
          routeBasePath: "docs",
          editUrl: "https://github.com/proofofwork-agency/dogfood/edit/main/docs/",
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Options,
    ],
  ],
  themeConfig: {
    image: "img/dogfood-social.png",
    colorMode: {
      defaultMode: "dark",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "DOGFOOD",
      logo: {
        alt: "Dogfood",
        src: "img/dogfood-mark.svg",
      },
      hideOnScroll: true,
      items: [
        { type: "docSidebar", sidebarId: "docsSidebar", position: "left", label: "Docs" },
        { to: "/docs/contract", label: "Contract", position: "left" },
        { to: "/docs/signing", label: "Signing", position: "left" },
        { to: "/docs/cli", label: "CLI", position: "left" },
        {
          href: "https://github.com/proofofwork-agency/dogfood",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Start",
          items: [
            { label: "Contract reference", to: "/docs/contract" },
            { label: "CLI reference", to: "/docs/cli" },
            { label: "Runnable examples", to: "/docs/examples" },
          ],
        },
        {
          title: "Proof",
          items: [
            { label: "Artifact bundles", to: "/docs/artifacts" },
            { label: "Signing and provenance", to: "/docs/signing" },
            { label: "Authoritative policy", to: "/docs/policy" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: "https://github.com/proofofwork-agency/dogfood" },
            { label: "Continuous integration", to: "/docs/ci" },
            { label: "Agent operation", to: "/docs/agents" },
          ],
        },
      ],
      copyright: `Apache-2.0. A PASS means the declared criteria were proven by the declared oracles — nothing more.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ["bash", "yaml", "json"],
    },
  } satisfies ThemeConfig,
}

export default config
