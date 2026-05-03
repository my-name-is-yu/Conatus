import {
  loadRelationshipProfile,
  selectActiveRelationshipProfileItems,
  type RelationshipProfileItem,
} from "./relationship-profile.js";

export interface RelationshipProfileRetrievalContext {
  scope: "memory_retrieval";
  includeSensitive: boolean;
  items: RelationshipProfileItem[];
}

export async function loadRelationshipProfileRetrievalContext(params: {
  baseDir: string;
  includeSensitive?: boolean;
}): Promise<RelationshipProfileRetrievalContext> {
  const includeSensitive = params.includeSensitive === true;
  const store = await loadRelationshipProfile(params.baseDir);
  return {
    scope: "memory_retrieval",
    includeSensitive,
    items: selectActiveRelationshipProfileItems(store, "memory_retrieval", { includeSensitive }),
  };
}

export function formatRelationshipProfileRetrievalContext(
  context: RelationshipProfileRetrievalContext
): string {
  if (context.items.length === 0) return "";
  return [
    `Relationship profile retrieval context (scope=${context.scope}; include_sensitive=${context.includeSensitive})`,
    "- Use these active profile items only as retrieval context.",
    "- Ignore superseded or retracted relationship profile items from older memory.",
    ...context.items.map((item) =>
      `- [${item.kind}] ${item.stable_key}: ${item.value} (confidence=${item.confidence.toFixed(2)}; sensitivity=${item.sensitivity}; version=${item.version})`
    ),
  ].join("\n");
}
