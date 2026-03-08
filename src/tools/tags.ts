import { z } from "zod";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import { tags } from "../db/schema.js";

export function registerTagTools(server: McpServer, db: Database) {
  // --- list_tags ---
  server.tool("list_tags", "List all tags", {}, async () => {
    const rows = await db
      .select({
        id: tags.id,
        name: tags.name,
        createdAt: tags.createdAt,
      })
      .from(tags)
      .orderBy(tags.name);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
    };
  });

  // --- create_tag ---
  server.tool(
    "create_tag",
    "Create a new tag with a unique name",
    {
      name: z.string().describe("Tag name (must be unique)"),
    },
    async ({ name }) => {
      // Check for existing tag with same name
      const existing = await db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.name, name));

      if (existing.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Tag with name "${name}" already exists (id: ${existing[0].id})`,
            },
          ],
        };
      }

      const id = uuidv7();
      await db.insert(tags).values({ id, name });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, name }),
          },
        ],
      };
    },
  );

  // --- delete_tag ---
  server.tool(
    "delete_tag",
    "Delete a tag and all its transaction associations (CASCADE)",
    {
      id: z.string().uuid().describe("Tag ID to delete"),
    },
    async ({ id }) => {
      // Check if tag exists
      const tag = await db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(eq(tags.id, id));

      if (tag.length === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Tag not found: ${id}` }],
        };
      }

      // Delete the tag - transaction_tags will cascade automatically via FK
      await db.delete(tags).where(eq(tags.id, id));

      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted tag "${tag[0].name}" (${id})`,
          },
        ],
      };
    },
  );
}
