import { stripVTControlCharacters } from "node:util";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Plain terminal cells, retaining whole graphemes and reserving a cell for ellipsis. */
export function compactText(value: string | undefined, cells = 20, middle = false): string | undefined {
  if (!value) return undefined;
  const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\u200d" ? char : " ")
    .replace(/\s+/g, " ").trim();
  const parts = Array.from(segments.segment(clean), ({ segment }) => ({ segment,
    width: /^[\p{Mark}\u200d]+$/u.test(segment) ? 0 :
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(segment) ? 2 : 1,
  }));
  if (parts.reduce((total, part) => total + part.width, 0) <= cells && Buffer.byteLength(clean) <= 160) return clean || undefined;
  let suffix = "";
  let suffixWidth = 0;
  let end = parts.length;
  if (middle) {
    for (const part of parts.toReversed()) {
      if (suffixWidth + part.width > Math.ceil((cells - 1) / 2) || Buffer.byteLength(part.segment + suffix) > 78) break;
      suffix = part.segment + suffix;
      suffixWidth += part.width;
      end--;
    }
  }
  let text = "";
  let width = suffixWidth;
  for (const part of parts.slice(0, end)) {
    if (width + part.width > cells - 1 || Buffer.byteLength(text + part.segment + suffix) > 157) break;
    text += part.segment;
    width += part.width;
  }
  return `${text.trimEnd()}…${suffix.trimStart()}`;
}

export interface WorkReference {
  readonly identifier: string;
  readonly repository?: string;
  readonly repositories?: readonly string[];
}

function explicitReference(text: string): WorkReference | undefined {
  const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i.exec(text);
  if (url) return { identifier: `${url[2]?.toLowerCase() === "pull" ? "PR" : "Issue"} #${url[3]}`, repository: url[1] };
  const ref = /^(?:(PR|Issue)\s+)?(?:([\w.-]+\/[\w.-]+))?#(\d+)$/i.exec(text);
  if (ref) return { identifier: `${ref[1] ? `${ref[1].toLowerCase() === "pr" ? "PR" : "Issue"} ` : ""}#${ref[3]}`, repository: ref[2] };
}

/** Only explicit reference syntax supplies kinds/numbers; at most two references form a pair. */
export function workReference(value: string | undefined): WorkReference | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const parts = text.split(/\s*[,·]\s*/);
  if (parts.length === 2) {
    const [first, second] = parts.map(explicitReference);
    if (first && second) {
      const repositories = [...new Set([first.repository, second.repository].filter((repo): repo is string => !!repo))];
      const short = [first.identifier, second.identifier].map(identifier => identifier.replace(/\s+/g, ""));
      const identifier = [
        `${first.identifier} · ${second.identifier}`,
        short.join("/"),
        short.map(part => part.replace(/^Issue/, "I")).join("/"),
        short.map(part => part.slice(part.indexOf("#"))).join("/"),
        `${short[0]} +1`,
        `${first.identifier.replace(/^Issue/, "I").replace(/\s+/g, "")} +1`,
        `${first.identifier.slice(first.identifier.indexOf("#"))} +1`,
        `${first.identifier.slice(first.identifier.indexOf("#") + 1)} +1`,
      ].find(value => value.length <= 20) ?? "2 references";
      return { identifier, repository: repositories[0],
        repositories: repositories.length > 1 ? repositories : undefined };
    }
  }
  return explicitReference(text) ?? { identifier: text };
}

export function projectLabel(reference: WorkReference | undefined, identity: { readonly project?: string; readonly repository?: string }): string | undefined {
  if (reference?.repositories?.length === 2) {
    const [first, second] = reference.repositories.map(repository => projectLabel({ identifier: "", repository }, identity));
    return `${compactText(first, 8, true)} + ${compactText(second, 9, true)}`;
  }
  const repo = reference?.repository;
  if (!repo || repo.toLowerCase() === identity.repository?.toLowerCase()) return compactText(identity.project, 20, true);
  const name = repo.split("/").at(-1);
  if (!identity.repository) return compactText(name, 20, true);
  const localName = identity.repository.split("/").at(-1);
  const sameName = name?.toLowerCase() === localName?.toLowerCase();
  const target = sameName ? repo : name;
  const local = sameName ? identity.project?.replace(localName ?? "", identity.repository) : identity.project;
  // Give both distinct identities space; the work-item number lives in its own token.
  return compactText(`${compactText(target, 8, true)} @ ${compactText(local, 9, true)}`, 20, true);
}
