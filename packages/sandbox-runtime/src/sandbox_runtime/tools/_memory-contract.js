// Generated from packages/shared/src/memory-tools.ts by `npm run generate:memory-contract -w @open-inspect/shared`. Do not edit.
export const MEMORY_CONTRACT = {
  "tools": [
    {
      "name": "memory_read",
      "description": "Read a current active fact by ID from the memory catalog or memory_search. Stored data may be stale. Pinned records that were archived return a notice instead of content. Directives are already in context and cannot be expanded.",
      "method": "GET",
      "path": "/sandbox-memory/{memoryId}",
      "inputSchema": {
        "type": "object",
        "properties": {
          "memoryId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "Memory ID from the catalog or memory_search"
          }
        },
        "required": [
          "memoryId"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "memory_write",
      "description": "Save what a future session can't learn from the repository and would otherwise get wrong: something the user asked you to remember, a user correction or standing preference, a non-obvious approach the user confirmed, or a verified, hard-won fact the repository doesn't record. Most sessions need no write; skip work summaries, status, fixes now in the code, sandbox quirks, guesses and duplicates. Check memory_search first and use supersedesMemoryId to update an existing fact. The server infers the session environment or sole repository; for multi-repository sessions, specify both repoOwner and repoName. Write a directive only when the user asks you to remember a preference. Never store credentials. Shared memories and directives require approval; the result states active or proposed. If proposed, tell the user it awaits review in Settings > Memories (personal) or Settings > Shared memories. Respect the user's personal-memory opt-out.",
      "method": "POST",
      "path": "/sandbox-memory",
      "inputSchema": {
        "type": "object",
        "properties": {
          "memoryType": {
            "type": "string",
            "enum": [
              "fact",
              "directive"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "description": {
            "type": "string",
            "minLength": 10,
            "maxLength": 420
          },
          "content": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000
          },
          "scopeType": {
            "type": "string",
            "enum": [
              "personal",
              "repository",
              "environment"
            ],
            "description": "Where to store the memory, relative to this session"
          },
          "repoOwner": {
            "description": "Repository owner; supply with repoName to pick one of several session repositories",
            "type": "string",
            "minLength": 1
          },
          "repoName": {
            "description": "Repository name; supply with repoOwner to pick one of several session repositories",
            "type": "string",
            "minLength": 1
          },
          "supersedesMemoryId": {
            "description": "Active memory in the same scope that this one replaces",
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "required": [
          "memoryType",
          "title",
          "description",
          "content",
          "scopeType"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "memory_search",
      "description": "Find active facts beyond the injected catalog using short literal keyword queries. Every whitespace-separated term must match the title, description, or body; there is no semantic search. Returns IDs and summaries, not bodies: use memory_read for full text. Repository scope searches all attached repositories unless both repoOwner and repoName select one. If hasMore is true, refine the query. Stored knowledge may be stale.",
      "method": "POST",
      "path": "/sandbox-memory/search",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "minLength": 2,
            "maxLength": 256,
            "description": "Short literal keywords; every term must match"
          },
          "scopeType": {
            "description": "Restrict to one scope type; omit to search every permitted session scope",
            "type": "string",
            "enum": [
              "personal",
              "repository",
              "environment"
            ]
          },
          "repoOwner": {
            "description": "Repository owner; supply with repoName to pick one of several session repositories",
            "type": "string",
            "minLength": 1
          },
          "repoName": {
            "description": "Repository name; supply with repoOwner to pick one of several session repositories",
            "type": "string",
            "minLength": 1
          },
          "limit": {
            "default": 10,
            "type": "integer",
            "minimum": 1,
            "maximum": 20
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      }
    }
  ],
  "sandboxSchemaVersion": 1,
  "limits": {
    "renderedChars": 240000
  }
};
