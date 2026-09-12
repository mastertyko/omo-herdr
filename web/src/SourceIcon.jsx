import { OpenAiLogo, GithubLogo, GitlabLogo, StackOverflowLogo, GoogleLogo, YoutubeLogo, RedditLogo, DiscordLogo, XLogo, DevToLogo, MediumLogo, CodepenLogo, CodesandboxLogo, ReplitLogo, FigmaLogo, SlackLogo, Globe } from "@phosphor-icons/react";
import { sourceHost } from "./research-graph.js";
import { sourceBrandMarks } from "./source-brand-marks.js";

// Bundled marks identify the source host without making favicon requests.
const brands = [
  { id: "openai", name: "OpenAI", domains: ["openai.com", "chatgpt.com"], icon: OpenAiLogo, weight: "regular" },
  { id: "github", name: "GitHub", domains: ["github.com"], icon: GithubLogo },
  { id: "gitlab", name: "GitLab", domains: ["gitlab.com"], icon: GitlabLogo, tone: "orange" },
  { id: "stackoverflow", name: "Stack Overflow", domains: ["stackoverflow.com"], icon: StackOverflowLogo, tone: "orange" },
  { id: "google", name: "Google", domains: ["google.com"], icon: GoogleLogo, tone: "blue" },
  { id: "youtube", name: "YouTube", domains: ["youtube.com", "youtu.be"], icon: YoutubeLogo, tone: "red" },
  { id: "reddit", name: "Reddit", domains: ["reddit.com", "redd.it"], icon: RedditLogo, tone: "orange" },
  { id: "discord", name: "Discord", domains: ["discord.com", "discord.gg"], icon: DiscordLogo, tone: "violet" },
  { id: "x", name: "X", domains: ["x.com", "twitter.com"], icon: XLogo, weight: "regular" },
  { id: "devto", name: "DEV Community", domains: ["dev.to"], icon: DevToLogo },
  { id: "medium", name: "Medium", domains: ["medium.com"], icon: MediumLogo },
  { id: "codepen", name: "CodePen", domains: ["codepen.io"], icon: CodepenLogo },
  { id: "codesandbox", name: "CodeSandbox", domains: ["codesandbox.io"], icon: CodesandboxLogo },
  { id: "replit", name: "Replit", domains: ["replit.com"], icon: ReplitLogo, tone: "orange" },
  { id: "figma", name: "Figma", domains: ["figma.com"], icon: FigmaLogo, tone: "violet" },
  { id: "slack", name: "Slack", domains: ["slack.com", "slack.dev"], icon: SlackLogo, tone: "violet" },
  { id: "mdn", name: "MDN Web Docs", domains: ["developer.mozilla.org"], mark: "mdnwebdocs" },
  { id: "npm", name: "npm", domains: ["npmjs.com", "npmjs.org"], mark: "npm", tone: "red" },
  { id: "nodejs", name: "Node.js", domains: ["nodejs.org"], mark: "nodedotjs", tone: "green" },
  { id: "react", name: "React", domains: ["react.dev", "reactjs.org"], mark: "react", tone: "cyan" },
  { id: "typescript", name: "TypeScript", domains: ["typescriptlang.org"], mark: "typescript", tone: "blue" },
  { id: "docker", name: "Docker", domains: ["docker.com", "docker.io"], mark: "docker", tone: "blue" },
  { id: "vercel", name: "Vercel", domains: ["vercel.com"], mark: "vercel" },
  { id: "nextjs", name: "Next.js", domains: ["nextjs.org"], mark: "nextdotjs" },
  { id: "supabase", name: "Supabase", domains: ["supabase.com"], mark: "supabase", tone: "green" },
  { id: "python", name: "Python", domains: ["python.org"], mark: "python", tone: "yellow" },
  { id: "rust", name: "Rust", domains: ["rust-lang.org"], mark: "rust", tone: "orange" },
  { id: "go", name: "Go", domains: ["go.dev", "golang.org"], mark: "go", tone: "cyan" },
];
const unknown = { id: "website", name: "Website", icon: Globe, weight: "regular", tone: "muted" };

export function sourceBrand(url) {
  const host = sourceHost(url).toLowerCase().replace(/\.$/, "");
  return brands.find((brand) => brand.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) ?? unknown;
}

export function SourceIcon({ url, size = "card" }) {
  const brand = sourceBrand(url);
  const Icon = brand.icon;
  const mark = sourceBrandMarks[brand.mark];
  return <span className={`source-icon source-icon-${size}`} data-source-brand={brand.id} data-source-tone={brand.tone} title={brand.name} aria-hidden="true">
    {mark ? <svg viewBox={mark.viewBox} fill="currentColor" focusable="false"><path d={mark.path} /></svg>
      : <Icon weight={brand.weight ?? "fill"} />}
  </span>;
}
