import { apiError } from './store.mjs';

const MAX_RESULTS = 100;
const MAX_QUERY_CHARACTERS = 200;
const SNIPPET_CHARACTERS = 240;

function searchText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Return plain text, never highlighted HTML. Unicode boundaries are preserved,
// including when lowercasing expands a character before the matching phrase.
function matchingSnippet(value, needle) {
  const text = searchText(value);
  const foldedIndex = text.toLowerCase().indexOf(needle);
  if (foldedIndex < 0) return null;
  let originalIndex = 0, foldedOffset = 0;
  for (const point of text) {
    const width = point.toLowerCase().length;
    if (foldedOffset + width > foldedIndex) break;
    foldedOffset += width;
    originalIndex += point.length;
  }
  let prefixStart = Math.max(0, originalIndex - 64);
  if (prefixStart > 0 && /[\uDC00-\uDFFF]/.test(text[prefixStart])) prefixStart--;
  const prefix = Array.from(text.slice(prefixStart, originalIndex)).slice(-32).join('');
  const start = originalIndex - prefix.length;
  const leading = start > 0 ? '…' : '';
  const available = SNIPPET_CHARACTERS - leading.length;
  const points = Array.from(text.slice(start, start + (available + 1) * 2));
  const segment = points.slice(0, available).join('');
  if (start + segment.length >= text.length) return leading + segment;
  return leading + points.slice(0, available - 1).join('') + '…';
}

function latestMessageMatch(state, needle) {
  const turns = state.thread?.turns || [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex];
    const hidden = new Set([...(turn.deletedRoles || []), ...(state.messageDeletions?.[turn.id] || [])]);
    const items = turn.items || [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      let role, value;
      if (item.type === 'userMessage') {
        role = 'user';
        value = (Array.isArray(item.content) ? item.content : []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
      } else if (item.type === 'agentMessage') {
        role = 'assistant';
        value = item.text;
      } else continue;
      if (hidden.has(role)) continue;
      const snippet = matchingSnippet(value, needle);
      if (snippet !== null) return { turnId: turn.id, role, snippet };
    }
  }
  return null;
}

function compareResults(left, right) {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

/**
 * Search all conversations the authenticated owner can read, without touching
 * the file system, native Codex history, other owners, approvals, or tool logs.
 * The caller must pass the owner from trusted authentication, never user input.
 *
 * Project matches have no conversationId. Conversation matches are deduplicated
 * to one result, preferring the title, then the most recent visible message.
 */
export function searchCodexConversations(store, ownerId, options = {}) {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || ownerId > 9999999999) throw apiError(400, 'invalid_owner', 'Invalid conversation owner');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw apiError(400, 'invalid_search', 'Invalid conversation search');
  if (typeof options.query !== 'string' || options.query.length > MAX_QUERY_CHARACTERS * 2) throw apiError(400, 'invalid_search_query', 'Enter a search query of up to 200 characters');
  const query = searchText(options.query);
  if (!query || Array.from(query).length > MAX_QUERY_CHARACTERS) throw apiError(400, 'invalid_search_query', 'Enter a search query of up to 200 characters');
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw apiError(400, 'invalid_search_limit', 'Search limit must be between 1 and 100');
  const includeArchived = options.includeArchived ?? true;
  if (typeof includeArchived !== 'boolean') throw apiError(400, 'invalid_search_archive_filter', 'Choose whether to include archived conversations');
  const needle = query.toLowerCase();
  const results = [], seen = new Set();
  for (const workspace of store.list(ownerId)) {
    // Even a listed project is resolved through the same owner check used by
    // detail requests. Never traverse store.states/allStates directly here.
    const root = store.get(ownerId, workspace.id);
    const workspaceArchived = root.workspace.archived === true;
    if (!includeArchived && workspaceArchived) continue;
    const workspaceName = searchText(root.workspace.name);
    const projectSnippet = matchingSnippet(workspaceName, needle);
    if (projectSnippet !== null) {
      const id = `project:${workspace.id}`;
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ id, workspaceId: workspace.id, workspaceName, conversationName: '', workspaceArchived, conversationArchived: false, matchType: 'project', snippet: projectSnippet, updatedAt: Number(root.workspace.updatedAt) || 0 });
      }
    }
    for (const conversation of store.conversations(root)) {
      const id = `conversation:${workspace.id}:${conversation.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = store.get(ownerId, workspace.id, conversation.id);
      const conversationArchived = state.conversation.archived === true;
      if (!includeArchived && conversationArchived) continue;
      const conversationName = searchText(state.conversation.name);
      const titleSnippet = matchingSnippet(conversationName, needle);
      const message = titleSnippet === null ? latestMessageMatch(state, needle) : null;
      if (titleSnippet === null && !message) continue;
      results.push({
        id, workspaceId: workspace.id, workspaceName,
        conversationId: conversation.id, conversationName,
        workspaceArchived, conversationArchived,
        matchType: titleSnippet === null ? 'message' : 'conversation',
        snippet: titleSnippet ?? message.snippet,
        ...(message ? { turnId: message.turnId, role: message.role } : {}),
        updatedAt: Number(state.conversation.updatedAt) || 0,
      });
      // Keep memory bounded while still checking every allowed conversation.
      if (results.length > limit + 1) {
        results.sort(compareResults);
        results.length = limit + 1;
      }
    }
    if (results.length > limit + 1) {
      results.sort(compareResults);
      results.length = limit + 1;
    }
  }
  results.sort(compareResults);
  return { query, results: results.slice(0, limit), hasMore: results.length > limit };
}
