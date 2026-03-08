import type { ContentType, RoutingRule } from "./types.js";

interface ResolveOptions {
  companion: string | null;
  type: ContentType;
  tags: string[];
  explicitPath?: string;
}

export class RouteResolver {
  constructor(private rules: RoutingRule[]) {}

  resolve(options: ResolveOptions): string {
    if (options.explicitPath) return options.explicitPath;

    for (const rule of this.rules) {
      if (rule.companion !== undefined && rule.companion !== options.companion) continue;
      if (rule.type !== undefined && rule.type !== options.type) continue;
      if (rule.tag !== undefined && !options.tags.includes(rule.tag)) continue;
      return rule.destination;
    }

    return "00 - INBOX/";
  }
}
