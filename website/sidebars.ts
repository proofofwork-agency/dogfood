import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

const sidebars: SidebarsConfig = {
  docsSidebar: [
    { type: "category", label: "Write a contract", collapsed: false, items: ["contract", "playwright", "junit", "advisory"] },
    { type: "category", label: "Prove it", collapsed: false, items: ["cli", "policy", "artifacts", "signing"] },
    { type: "category", label: "Operate", collapsed: false, items: ["ci", "agents", "examples", "licensing"] },
  ],
}

export default sidebars
