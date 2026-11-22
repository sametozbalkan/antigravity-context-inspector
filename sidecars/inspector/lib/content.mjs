/**
 * Extract raw context window items: system sections, tool schemas, and messages.
 */

import {
  CAT_AGENT,
  CAT_CHECKPOINT,
  CAT_SYSTEM,
  CAT_TOOL,
  CAT_USER,
  GROUP_LABELS,
  STEP_PLANNER_RESPONSE,
  STEP_TYPE_NAMES,
  STEP_USER_INPUT,
  SYSTEM_PROMPT_SUBGROUPS,
  TOKEN_CHAT_MESSAGES,
  TOKEN_FLOWS,
  TOKEN_MCP_TOOLS,
  TOKEN_PLUGINS,
  TOKEN_RULES,
  TOKEN_SKILLS,
  TOKEN_SUBAGENTS,
  TOKEN_SYSTEM_PROMPT,
  TOKEN_TOOLS,
  TOKEN_WORKFLOWS,
  pct,
  round1,
  stepCategory,
  stepTokens,
} from './accounting.mjs';
import { utf8ByteLength } from './protobuf.mjs';

export const ROLE_MAP = {
  1: 'user',
  2: 'assistant',
  3: 'system',
  4: 'tool',
};

const SYSTEM_GROUP_TYPES = new Set([
  TOKEN_SYSTEM_PROMPT,
  TOKEN_RULES,
  TOKEN_SKILLS,
  TOKEN_SUBAGENTS,
  TOKEN_WORKFLOWS,
  TOKEN_PLUGINS,
  TOKEN_FLOWS,
]);

const INT_RE = /^[+-]?[0-9]+$/;

function partition(str, sep) {
  const idx = str.indexOf(sep);
  if (idx === -1) return [str, '', ''];
  return [str.slice(0, idx), sep, str.slice(idx + sep.length)];
}

export function makePreview(text, limit = 160) {
  if (!text || limit <= 0) {
    return '';
  }
  const parts = [];
  let total = 0;
  let truncated = false;
  const re = new RegExp(`\\S{1,${limit + 1}}`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    if (parts.length > 0) {
      total += 1;
    }
    if (total + token.length > limit) {
      const rem = Math.max(0, limit - 1 - total);
      if (rem > 0) {
        parts.push(token.slice(0, rem));
      }
      truncated = true;
      break;
    }
    parts.push(token);
    total += token.length;
  }
  let flat = parts.join(' ');
  if (!truncated) {
    return flat;
  }
  if (flat.length >= limit) {
    flat = flat.slice(0, limit - 1);
  }
  return `${flat.trimEnd()}…`;
}

/**
 * Infer MCP server name from common tool naming conventions.
 */
export function extractMcpServer(name) {
  if (!name) {
    return 'other';
  }
  if (name.includes('__')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 2) {
      if (parts[0].toLowerCase() === 'mcp' && parts.length >= 3) {
        return parts[1];
      }
      if (parts[0].toLowerCase() !== 'mcp') {
        const first = parts[0];
        if (first.toLowerCase().startsWith('mcp_')) {
          const stripped = first.slice(4);
          if (stripped.includes('_')) {
            const [server] = partition(stripped, '_');
            if (server) return server;
          } else if (stripped) {
            return stripped;
          }
        } else {
          return first;
        }
      }
    }
  }
  for (const sep of [':', '/']) {
    if (name.includes(sep)) {
      let prefix = name.split(sep, 1)[0].trim();
      if (prefix.toLowerCase().startsWith('mcp_')) {
        prefix = prefix.slice(4);
      }
      if (prefix) {
        return prefix;
      }
    }
  }
  if (name.toLowerCase().startsWith('mcp_')) {
    const rest = name.slice(4);
    const [server, sep] = partition(rest, '_');
    if (sep && server) {
      return server;
    }
  }
  return 'other';
}

/**
 * Build exact per-item token lookups from ContextWindowMetadata.breakdown.
 */
export function parseBreakdownMaps(breakdown) {
  const section_tokens = new Map();
  const section_tokens_by_name = new Map();
  const section_group = new Map();
  const sys_tool_tokens = new Map();
  const mcp_tool_tokens = new Map();
  const step_tokens_map = new Map();

  if (breakdown == null) {
    return {
      section_tokens,
      section_tokens_by_name,
      section_group,
      sys_tool_tokens,
      mcp_tool_tokens,
      step_tokens_map,
    };
  }

  for (const g of breakdown.msgs(1)) {
    const gtype = g.int(2);
    const children = g.msgs(5);
    if (SYSTEM_GROUP_TYPES.has(gtype)) {
      for (const ch of children) {
        const cname = ch.str(1);
        const ctok = Math.max(0, ch.int(3, { signed32: true }));
        const effGtype =
          gtype === TOKEN_SYSTEM_PROMPT && Object.hasOwn(SYSTEM_PROMPT_SUBGROUPS, cname)
            ? SYSTEM_PROMPT_SUBGROUPS[cname]
            : gtype;
        section_tokens.set(`${effGtype}\0${cname}`, ctok);
        if (!section_tokens_by_name.has(cname)) {
          section_tokens_by_name.set(cname, ctok);
        }
        if (!section_group.has(cname)) {
          section_group.set(cname, effGtype);
        }
      }
    } else if (gtype === TOKEN_TOOLS) {
      for (const ch of children) {
        sys_tool_tokens.set(ch.str(1), Math.max(0, ch.int(3, { signed32: true })));
      }
    } else if (gtype === TOKEN_MCP_TOOLS) {
      for (const ch of children) {
        mcp_tool_tokens.set(ch.str(1), Math.max(0, ch.int(3, { signed32: true })));
      }
    } else if (gtype === TOKEN_CHAT_MESSAGES) {
      for (const ch of children) {
        const [left, sep, right] = partition(ch.str(1), ': ');
        if (sep && INT_RE.test(left)) {
          step_tokens_map.set(
            Number.parseInt(left, 10),
            [right, Math.max(0, ch.int(3, { signed32: true }))],
          );
        }
      }
    }
  }

  return {
    section_tokens,
    section_tokens_by_name,
    section_group,
    sys_tool_tokens,
    mcp_tool_tokens,
    step_tokens_map,
  };
}

/**
 * Extract system prompt sections, tool declarations, and active chat messages.
 */
export function extractContentItems(steps, contentGen, breakdown, totalUsed) {
  const maps = parseBreakdownMaps(breakdown);
  const sectionTokens = maps.section_tokens;
  const sectionTokensByName = maps.section_tokens_by_name;
  const sectionGroup = maps.section_group;
  const sysToolTokens = maps.sys_tool_tokens;
  const mcpToolTokens = maps.mcp_tool_tokens;
  const stepTokensMap = maps.step_tokens_map;

  const chat = contentGen != null ? contentGen.msg(1) : null;
  const denom = Math.max(totalUsed, 1);

  // 1. System prompt sections
  const system_sections = [];
  if (chat != null && chat.has(16)) {
    const sections = chat.msgs(16);
    for (let idx = 0; idx < sections.length; idx += 1) {
      const sb = sections[idx];
      const name = sb.str(1) || `section_${idx}`;
      const body = sb.str(2);
      let gtype =
        sb.int(6) || (sectionGroup.has(name) ? sectionGroup.get(name) : TOKEN_SYSTEM_PROMPT);
      if (gtype === TOKEN_SYSTEM_PROMPT && Object.hasOwn(SYSTEM_PROMPT_SUBGROUPS, name)) {
        gtype = SYSTEM_PROMPT_SUBGROUPS[name];
      }
      const key = `${gtype}\0${name}`;
      let tok = sectionTokens.has(key)
        ? sectionTokens.get(key)
        : sectionTokensByName.has(name)
          ? sectionTokensByName.get(name)
          : 0;
      let estimated = false;
      if (tok <= 0 && body) {
        tok = Math.max(1, Math.floor(utf8ByteLength(body) / 4));
        estimated = true;
      }
      system_sections.push({
        id: `sys-${idx}-${name}`,
        kind: 'system',
        order: idx,
        name,
        group: Object.hasOwn(GROUP_LABELS, gtype) ? GROUP_LABELS[gtype] : 'System prompt',
        group_type: gtype,
        tokens: tok,
        pct: round1(pct(tok, denom)),
        estimated,
        chars: body.length,
        preview: makePreview(body),
        content: body,
      });
    }
  } else if (chat != null && chat.has(1)) {
    const rawSys = chat.str(1);
    if (rawSys) {
      let tok = 0;
      for (const v of sectionTokens.values()) {
        tok += v;
      }
      if (!tok) {
        tok = Math.max(1, Math.floor(utf8ByteLength(rawSys) / 4));
      }
      system_sections.push({
        id: 'sys-0-system_prompt',
        kind: 'system',
        order: 0,
        name: 'system_prompt',
        group: 'System prompt',
        group_type: TOKEN_SYSTEM_PROMPT,
        tokens: tok,
        pct: round1(pct(tok, denom)),
        estimated: sectionTokens.size === 0,
        chars: rawSys.length,
        preview: makePreview(rawSys),
        content: rawSys,
      });
    }
  }

  // 2. Tool declarations
  const tools = [];
  if (chat != null && chat.has(8)) {
    const toolMsgs = chat.msgs(8);
    for (let idx = 0; idx < toolMsgs.length; idx += 1) {
      const tb = toolMsgs[idx];
      const name = tb.str(1) || `tool_${idx}`;
      const desc = tb.str(2);
      const schemaRaw = tb.str(3);
      let schemaPretty = schemaRaw;
      if (schemaRaw && schemaRaw.length <= 100_000) {
        try {
          schemaPretty = JSON.stringify(JSON.parse(schemaRaw), null, 2);
        } catch {
          // keep raw schema string on invalid JSON
        }
      }

      let isMcp;
      let tok;
      let estimated;
      if (mcpToolTokens.has(name)) {
        isMcp = true;
        tok = mcpToolTokens.get(name);
        estimated = false;
      } else if (sysToolTokens.has(name)) {
        isMcp = false;
        tok = sysToolTokens.get(name);
        estimated = false;
      } else {
        isMcp = name.startsWith('mcp_');
        tok = Math.max(1, Math.floor((name.length + desc.length + schemaRaw.length) / 4));
        estimated = true;
      }

      const fullText = schemaPretty
        ? `# ${name}\n\n${desc}\n\nParameters:\n${schemaPretty}`
        : `# ${name}\n\n${desc}`;
      tools.push({
        id: `tool-${idx}-${name}`,
        kind: 'tool',
        order: idx,
        name,
        is_mcp: isMcp,
        mcp_server: isMcp ? extractMcpServer(name) : '',
        group: isMcp ? 'MCP tools' : 'System tools',
        description: desc,
        schema: schemaPretty,
        tokens: tok,
        pct: round1(pct(tok, denom)),
        estimated,
        chars: desc.length + schemaRaw.length,
        preview: makePreview(desc || schemaRaw),
        content: fullText,
      });
    }
  }

  // 3. Active conversation messages
  const messages = [];
  const callIdToName = new Map();

  if (chat != null && chat.has(2)) {
    const chatMsgs = chat.msgs(2);
    for (let idx = 0; idx < chatMsgs.length; idx += 1) {
      const mb = chatMsgs[idx];
      const roleNum = mb.int(2);
      const role = Object.hasOwn(ROLE_MAP, roleNum) ? ROLE_MAP[roleNum] : `role_${roleNum}`;
      const text = mb.str(3);
      const thinking = mb.str(11);
      const stepIdx = mb.has(18)
        ? mb.int(18, { signed32: true })
        : idx === 0 && stepTokensMap.has(0)
          ? 0
          : -1;
      const toolCallId = mb.str(7);

      const toolCalls = [];
      for (const tc of mb.msgs(6)) {
        const tcId = tc.str(1);
        const tcName = tc.str(2);
        const tcArgsRaw = tc.str(3);
        let tcArgsPretty = tcArgsRaw;
        if (tcArgsRaw && tcArgsRaw.length <= 100_000) {
          try {
            tcArgsPretty = JSON.stringify(JSON.parse(tcArgsRaw), null, 2);
          } catch {
            // keep raw arguments string on invalid JSON
          }
        }
        if (tcId && tcName) {
          callIdToName.set(tcId, tcName);
        }
        toolCalls.push({
          id: tcId,
          name: tcName,
          arguments: tcArgsPretty,
          raw_arguments: tcArgsRaw,
        });
      }

      const resolvedToolName = toolCallId ? callIdToName.get(toolCallId) || '' : '';
      let tok = mb.int(4, { signed32: true });
      let stepTypeLabel = '';
      if (stepTokensMap.has(stepIdx)) {
        const [bdLabel, bdTok] = stepTokensMap.get(stepIdx);
        stepTypeLabel = bdLabel;
        if (tok <= 0) {
          tok = bdTok;
        }
      }

      let tcChars = 0;
      for (const tc of toolCalls) {
        tcChars += tc.raw_arguments.length + tc.name.length;
      }
      const combinedChars = text.length + thinking.length + tcChars;
      let estimated = false;
      if (tok <= 0 && combinedChars > 0) {
        tok = Math.max(1, Math.floor(combinedChars / 4));
        estimated = true;
      }

      let label;
      if (role === 'user') {
        label = 'User message';
      } else if (role === 'assistant') {
        if (toolCalls.length > 0 && !text.trim()) {
          let names = toolCalls
            .slice(0, 3)
            .map((tc) => tc.name)
            .join(', ');
          if (toolCalls.length > 3) {
            names += ` +${toolCalls.length - 3}`;
          }
          label = `Agent → ${names}`;
        } else if (toolCalls.length > 0) {
          label = `Agent reply + ${toolCalls.length} tool call(s)`;
        } else {
          label = 'Agent response';
        }
      } else if (role === 'tool') {
        label = resolvedToolName ? `Tool result · ${resolvedToolName}` : 'Tool result';
      } else if (role === 'system') {
        label = 'System message';
      } else {
        label = `Message (${role})`;
      }

      const previewSrc =
        text ||
        (toolCalls.length > 0
          ? `Calls: ${toolCalls.map((tc) => tc.name).join(', ')}`
          : thinking);

      messages.push({
        id: `msg-${idx}`,
        kind: 'message',
        order: idx,
        index: idx,
        step_index: stepIdx,
        step_type: stepTypeLabel,
        role,
        label,
        tool_name: resolvedToolName,
        tool_call_id: toolCallId,
        tool_names: toolCalls.map((tc) => tc.name),
        tool_call_count: toolCalls.length,
        has_thinking: Boolean(thinking.trim()),
        tokens: tok,
        pct: round1(pct(tok, denom)),
        estimated,
        chars: combinedChars,
        preview: makePreview(previewSrc),
        text,
        thinking,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });
    }
  } else if (steps && steps.length > 0) {
    const catToRole = {
      [CAT_USER]: 'user',
      [CAT_AGENT]: 'assistant',
      [CAT_TOOL]: 'tool',
      [CAT_SYSTEM]: 'system',
      [CAT_CHECKPOINT]: 'system',
    };
    for (let idx = 0; idx < steps.length; idx += 1) {
      const step = steps[idx];
      const cat = stepCategory(step.type);
      const role = Object.hasOwn(catToRole, cat) ? catToRole[cat] : 'tool';
      let text = '';
      let thinking = '';
      const ui = step.payload(STEP_USER_INPUT);
      const pr = step.payload(STEP_PLANNER_RESPONSE);
      if (ui != null) {
        text = ui.str(2);
      } else if (pr != null) {
        text = pr.str(1);
        thinking = pr.str(3);
      } else {
        const tc = step.md.msg(4);
        if (tc != null) {
          text = `${tc.str(2)}(${tc.str(3)})`;
        }
      }
      const tok = stepTokens(step);
      const sname = Object.hasOwn(STEP_TYPE_NAMES, step.type)
        ? STEP_TYPE_NAMES[step.type]
        : `STEP_${step.type}`;
      const roleTitle = role ? `${role[0].toUpperCase()}${role.slice(1)}` : '';
      messages.push({
        id: `msg-${idx}`,
        kind: 'message',
        order: idx,
        index: idx,
        step_index: step.pos,
        step_type: sname,
        role,
        label: `${roleTitle} (${sname})`,
        tool_name: '',
        tool_call_id: '',
        tool_names: [],
        tool_call_count: 0,
        has_thinking: Boolean(thinking.trim()),
        tokens: tok,
        pct: round1(pct(tok, denom)),
        estimated: true,
        chars: text.length + thinking.length,
        preview: makePreview(text || thinking || sname),
        text,
        thinking,
        tool_calls: [],
      });
    }
  }

  return {
    system_sections,
    tools,
    messages,
  };
}
