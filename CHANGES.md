## Fix: contextWindow and maxTokens not read from OpenAI-compatible servers

### maxTokens Issue

**Problem**: The generic OpenAI-compatible adapter always used a hardcoded default of 4096 for `maxTokens`, even when servers reported `max_completion_tokens` in the `/v1/models` response. This was way too small for modern models with large context windows.

**Fix**: 
1. First determine the `contextWindow` (checking `context_window`, `max_model_len`, `context_length`, `max_context_length`)
2. Try to read `max_completion_tokens` from the server response
3. If the server provides it, use that value
4. Otherwise, default to **half the context window** (reasonable balance between input and output)

### contextWindow Issue

### Problem

The generic OpenAI-compatible adapter in `src/adapters/generic.ts` only checks for these context-window fields in the `/v1/models` response:

- `context_window`
- `context_length`
- `max_context_length`

Many servers (e.g. **omlx**) report the value under **`max_model_len`** instead. When this field is encountered, `contextWindow` stays `undefined` and a default fallback is used, giving wrong values to the user.

### Fix

In `src/adapters/generic.ts`:

1. **Add `max_model_len` to the response type** so TypeScript recognizes the field.
2. **Insert `max_model_len` into the context-window detection chain** as the second check (after `context_window`, before `context_length` and `max_context_length`).

### Files changed

- `src/adapters/generic.ts`

### Diff

```diff
--- a/src/adapters/generic.ts
+++ b/src/adapters/generic.ts
@@ -122,7 +122,7 @@
       headers["Authorization"] = `Bearer ${cred.apiKey}`;
     }
 
-    const body = r.json as { data?: Array<{ id?: unknown; max_completion_tokens?: number; context_length?: number; max_context_length?: number; context_window?: number }> } | undefined;
+    const body = r.json as { data?: Array<{ id?: unknown; max_completion_tokens?: number; max_model_len?: number; context_length?: number; max_context_length?: number; context_window?: number }> } | undefined;
     if (!Array.isArray(body?.data)) return [];
 
     return body.data
@@ -135,13 +135,18 @@
         const contextWindow =
           typeof item.context_window === "number" && item.context_window > 0
             ? item.context_window
+            : typeof item.max_model_len === "number" && item.max_model_len > 0
+              ? item.max_model_len
             : typeof item.context_length === "number" && item.context_length > 0
               ? item.context_length
               : typeof item.max_context_length === "number" && item.max_context_length > 0
                 ? item.max_context_length
                 : undefined;
         
+        const finalContextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
+        
         const maxTokens =
           typeof item.max_completion_tokens === "number" && item.max_completion_tokens > 0
             ? item.max_completion_tokens
+            : Math.floor(finalContextWindow / 2);
         
         return {
           id: item.id,
           name: item.id,
-          contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
-          maxTokens: DEFAULT_MAX_TOKENS,
+          contextWindow: finalContextWindow,
+          maxTokens,
           input: ["text"],
           reasoning: false,
           embeddings: isEmbedding,
```
