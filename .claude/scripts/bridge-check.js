#!/usr/bin/env node
// Cross-Claude Bridge — UserPromptSubmit hook
//
// 매 프롬프트 제출 직전 Claude Code 가 이 스크립트를 실행. stdout 은 다음 LLM 호출의
// 컨텍스트에 자동 주입된다. 메시지가 있으면 한 줄짜리 알림 + 최근 5건의 frontmatter
// 한 줄 요약을 출력. 메시지가 없으면 아무것도 출력 안 함 (조용함).
//
// role 결정 우선순위:
//   1. <repo-root>/.bridge-config.json 의 role 필드
//   2. OS 자동 감지 (linux→backend, win32→frontend)
//
// 절대 throw 하지 않음 — 사용자 워크플로우를 깨뜨리면 안 됨.

const fs = require("fs");
const path = require("path");
const os = require("os");

// .claude/scripts/bridge-check.js → repo root 는 두 단계 위
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function detectRoleAndShared() {
  // 1. .bridge-config.json 우선
  const cfg = path.join(REPO_ROOT, ".bridge-config.json");
  if (fs.existsSync(cfg)) {
    try {
      const d = JSON.parse(fs.readFileSync(cfg, "utf-8"));
      const role = (d.role || "").trim();
      const shared = (d.shared_dir || "").trim();
      // example 값 placeholder ("backend | frontend") 무시
      if (role && shared && !role.includes("|") && !shared.includes("|")) {
        return { role, shared, source: "config" };
      }
    } catch (_) {
      // ignore — fallback 으로
    }
  }
  // 2. OS fallback
  const plat = os.platform();
  if (plat === "win32") {
    return { role: "frontend", shared: "C:/shared/claude-bridge", source: "os" };
  }
  if (plat === "linux") {
    return { role: "backend", shared: "/mnt/c/shared/claude-bridge", source: "os" };
  }
  return { role: null, shared: null, source: null };
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/).slice(0, 30);
  const fm = {};
  let inFm = false;
  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFm) {
        inFm = true;
        continue;
      } else {
        break;
      }
    }
    if (!inFm) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function main() {
  const { role, shared } = detectRoleAndShared();
  if (!role || !shared) return;

  const inbox = path.join(shared, "inbox", role);
  if (!fs.existsSync(inbox)) return;

  let entries;
  try {
    entries = fs.readdirSync(inbox);
  } catch (_) {
    return;
  }
  const msgs = entries
    .filter((n) => n.endsWith(".md") && !n.startsWith(".tmp-"))
    .sort();
  if (msgs.length === 0) return;

  const tail = msgs.slice(-5); // 너무 많으면 최근 5건만
  console.log(
    `[cross-claude-bridge] inbox/${role}: ${msgs.length} unread message(s)${
      msgs.length > tail.length ? ` (showing latest ${tail.length})` : ""
    }`
  );
  for (const name of tail) {
    let fm = {};
    try {
      const txt = fs.readFileSync(path.join(inbox, name), "utf-8");
      fm = parseFrontmatter(txt);
    } catch (_) {
      // 읽기 실패해도 파일명은 알림
    }
    const tag = fm.tag || "?";
    const from = fm.from || "?";
    const ts = fm.timestamp || "";
    const subject = fm.subject || "(no subject)";
    console.log(`  - [${tag}] from=${from} ${ts} — ${subject}  (${name})`);
  }
  console.log(
    `  → 처리: 본문 read → tag 별 룰대로 (info=흡수, request/question=확인, urgent=즉시) → processed/${role}/ 로 이동`
  );
}

try {
  main();
} catch (_) {
  // 절대 throw 금지 — 사용자 prompt 진행이 우선
}
