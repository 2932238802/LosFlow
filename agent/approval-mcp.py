#!/usr/bin/env python3
# approval-mcp.py -- Claude Code 的「问人」端点（stdio MCP，单文件、只用标准库）。
#
# Claude Code 以 `--permission-prompt-tool mcp__losflow-approval__approval_prompt` 启动时，
# 任何不在 allowedTools 里的调用会先走到这里；我们把它写成 data/live/<id>.req.json，
# 等仪表盘（server/approvals.mjs）写 data/live/<id>.res.json，再把决定原路返回。
#
# 返回契约（Claude Code 2.1.x）：
#   允许 {"behavior":"allow","updatedInput":<原输入原样>}
#   拒绝 {"behavior":"deny","message":"<理由>"}
# updatedInput 必须满足工具自身的输入 schema；这里永远原样回传，不做改写。
#
# 失败降级：超时 / 文件读写失败 / 任何异常 -> 返回 deny + 明确理由，让 run 继续，
# 绝不挂死。默认等待 50 秒（MCP 工具调用可能有 60 秒上限）。
#
# 环境变量（由 runner 通过 --mcp-config 的 env 注入）：
#   LOSFLOW_DATA              data 目录（WSL: /mnt/d/.../data；Windows: D:\...\data）
#   LOSFLOW_LIVE_RUN          当前 runId
#   LOSFLOW_LIVE_TASK         当前 taskId
#   LOSFLOW_LIVE_REPO         工作目录（给人看的上下文）
#   LOSFLOW_APPROVAL_TIMEOUT  等待秒数（默认 50，上限 55）

import json
import os
import random
import sys
import time

SERVER_NAME = "losflow-approval"
TOOL_NAME = "approval_prompt"
TOOL_FULL_NAME = "mcp__%s__%s" % (SERVER_NAME, TOOL_NAME)
DEFAULT_TIMEOUT = 50


def _data_dir():
    d = os.environ.get("LOSFLOW_DATA", "").strip()
    if d:
        return d
    # 兜底：<repo>/agent/approval-mcp.py -> <repo>/data
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "data")


DATA_DIR = _data_dir()
LIVE_DIR = os.path.join(DATA_DIR, "live")
ARCHIVE_DIR = os.path.join(LIVE_DIR, "archive")


def _ensure_dirs():
    try:
        os.makedirs(LIVE_DIR, exist_ok=True)
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
    except Exception:
        pass


def _timeout_sec():
    try:
        n = int(os.environ.get("LOSFLOW_APPROVAL_TIMEOUT", str(DEFAULT_TIMEOUT)))
    except Exception:
        n = DEFAULT_TIMEOUT
    return max(5, min(55, n))


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _log(msg):
    try:
        _ensure_dirs()
        with open(os.path.join(LIVE_DIR, "mcp.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (_now(), msg))
    except Exception:
        pass


def _atomic_write_json(path, obj):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _rule_text(tool_name, rule):
    try:
        name = str(rule.get("toolName") or tool_name or "").strip()
        content = str(rule.get("ruleContent") or "").strip()
        if not name:
            return ""
        return "%s(%s)" % (name, content) if content else name
    except Exception:
        return ""


def _suggestions(tool_name, tool_input, permission_suggestions):
    out = []
    try:
        for s in permission_suggestions or []:
            if not isinstance(s, dict):
                continue
            for r in s.get("rules") or []:
                t = _rule_text(tool_name, r)
                if t:
                    out.append(t)
    except Exception:
        pass
    if not out and tool_name == "Bash":
        try:
            cmd = str((tool_input or {}).get("command") or "").strip()
            parts = cmd.split()
            if len(parts) >= 2:
                out.append("Bash(%s %s:*)" % (parts[0], parts[1]))
            elif len(parts) == 1:
                out.append("Bash(%s:*)" % parts[0])
        except Exception:
            pass
    # 去重保序
    seen = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def _summarize(tool_name, tool_input):
    try:
        if tool_name == "Bash":
            return str((tool_input or {}).get("command") or "")
        return json.dumps(tool_input or {}, ensure_ascii=False)[:1200]
    except Exception:
        return ""


def _new_id():
    return "lv-%s-%04x" % (time.strftime("%Y%m%d-%H%M%S"), random.randint(0, 0xFFFF))


def _archive(live_id):
    for suffix in (".req.json", ".res.json"):
        src = os.path.join(LIVE_DIR, live_id + suffix)
        if os.path.exists(src):
            try:
                os.replace(src, os.path.join(ARCHIVE_DIR, live_id + suffix))
            except Exception:
                try:
                    os.remove(src)
                except Exception:
                    pass


def _deny(message):
    return {"behavior": "deny", "message": message}


def _wait_for_answer(live_id, tool_input, timeout_sec):
    deadline = time.time() + timeout_sec
    res_path = os.path.join(LIVE_DIR, live_id + ".res.json")
    while time.time() < deadline:
        if os.path.exists(res_path):
            try:
                res = _read_json(res_path)
            except Exception:
                # 半截 JSON：给 server 的原子写一个重试窗口
                time.sleep(0.05)
                continue
            decision = str(res.get("decision") or "").lower()
            if decision == "allow":
                _log("%s allow" % live_id)
                return {"behavior": "allow", "updatedInput": tool_input if isinstance(tool_input, dict) else {}}
            _log("%s deny %s" % (live_id, str(res.get("message") or "")[:120]))
            return _deny(str(res.get("message") or "人工拒绝了这次调用"))
        time.sleep(0.2)
    _log("%s timeout" % live_id)
    return _deny("等待人工授权超时，按拒绝处理；不要换个写法重试，先向用户说明卡在哪里")


def approval_prompt(args):
    tool_name = str(args.get("tool_name") or "")
    tool_input = args.get("input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_use_id = str(args.get("tool_use_id") or "")
    timeout_sec = _timeout_sec()
    live_id = _new_id()

    req = {
        "v": 1,
        "id": live_id,
        "at": _now(),
        "atMs": int(time.time() * 1000),
        "runId": os.environ.get("LOSFLOW_LIVE_RUN", ""),
        "taskId": os.environ.get("LOSFLOW_LIVE_TASK", ""),
        "tool": tool_name,
        "input": tool_input,
        "toolUseId": tool_use_id,
        "suggestions": _suggestions(tool_name, tool_input, args.get("permission_suggestions")),
        "cwd": os.environ.get("LOSFLOW_LIVE_REPO", ""),
        "timeoutSec": timeout_sec,
    }

    try:
        _ensure_dirs()
        _atomic_write_json(os.path.join(LIVE_DIR, live_id + ".req.json"), req)
        _log("%s request tool=%s id=%s" % (live_id, tool_name, tool_use_id))
    except Exception as e:
        _log("%s req write failed: %s" % (live_id, e))
        return _deny("LosFlow 授权服务不可用（写请求文件失败）")

    try:
        decision = _wait_for_answer(live_id, tool_input, timeout_sec)
    except Exception as e:
        _log("%s wait failed: %s" % (live_id, e))
        decision = _deny("LosFlow 授权服务不可用（内部异常）")
    finally:
        _archive(live_id)
    return decision


def _tool_schema():
    return {
        "name": TOOL_NAME,
        "description": (
            "Ask the LosFlow dashboard whether a tool call may run. "
            "Returns {\"behavior\":\"allow\",\"updatedInput\":...} or {\"behavior\":\"deny\",\"message\":...}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": {"type": "string"},
                "input": {"type": "object"},
                "tool_use_id": {"type": "string"},
                "permission_suggestions": {"type": "array"},
            },
            "required": ["tool_name", "input"],
        },
    }


def _reply(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        proto = params.get("protocolVersion") or "2024-11-05"
        return _reply(msg_id, {
            "protocolVersion": proto,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": "1.0.0"},
        })
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "ping":
        return _reply(msg_id, {})
    if method == "tools/list":
        return _reply(msg_id, {"tools": [_tool_schema()]})
    if method == "tools/call":
        name = params.get("name")
        if name != TOOL_NAME:
            return _error(msg_id, -32601, "unknown tool: %s" % name)
        try:
            text = json.dumps(approval_prompt(params.get("arguments") or {}), ensure_ascii=False)
        except Exception as e:
            text = json.dumps(_deny("LosFlow 授权服务不可用（%s）" % e), ensure_ascii=False)
        return _reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
    if msg_id is None:
        return None
    return _error(msg_id, -32601, "method not found: %s" % method)


def main():
    _log("mcp started data=%s timeout=%ss pid=%s" % (DATA_DIR, _timeout_sec(), os.getpid()))
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            _log("bad json: %s" % e)
            continue
        if not isinstance(msg, dict):
            continue
        out = handle(msg)
        if out is None:
            continue
        sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
