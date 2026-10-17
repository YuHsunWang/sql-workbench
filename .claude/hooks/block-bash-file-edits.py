#!/usr/bin/env python3
"""PreToolUse hook: stop Claude from editing files through Bash.

Blocks shell commands that rewrite files in place (sed -i, perl -i, awk -i
inplace), redirect output into files (>, >>, &>, heredoc into a file) or
write via tee, and tells Claude to use the Edit / Write tools instead.

Writes to /dev/* (e.g. /dev/null) and to temp dirs (/tmp, $TMPDIR) are
allowed, since those are not project files.
"""
import json
import os
import re
import sys

REASON = (
    "Do not modify files with shell commands (sed -i, echo/cat > file, "
    "heredoc, tee, perl -i, ...). Use the Edit tool for changes to existing "
    "files and the Write tool for new files or full rewrites, then retry."
)

ALLOWED_PREFIXES = ["/dev/", "/tmp/"]
if os.environ.get("TMPDIR"):
    ALLOWED_PREFIXES.append(os.environ["TMPDIR"].rstrip("/") + "/")

IN_PLACE = [
    re.compile(r"\bsed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)\b"),
    re.compile(r"\bperl\b[^|;&]*\s-[a-zA-Z]*i"),
    re.compile(r"\b(g?awk)\b[^|;&]*-i\s*inplace\b"),
]

# > file, >> file, &> file, 1> file; not >&2, 2>&1, process substitution >(...)
REDIRECT = re.compile(r"(?<![<>])(?:&|\d)?>>?(?![&(>])\s*(\S+)")
TEE = re.compile(r"(?:^|[|;&(]\s*|\s)tee\b((?:\s+-\S+)*)\s*((?:\s*[^\s|;&)]+)*)")


def strip_quotes(cmd: str) -> str:
    """Blank out quoted strings so `echo "a > b"` is not seen as a redirect."""
    cmd = re.sub(r"'[^']*'", "''", cmd)
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', cmd)


def strip_heredoc_bodies(cmd: str) -> str:
    """Drop heredoc bodies; the `<<EOF` line itself (with any > file) stays."""
    out, lines, i = [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r"<<-?\s*['\"]?(\w+)['\"]?", line)
        i += 1
        if m:
            tag = m.group(1)
            while i < len(lines) and lines[i].strip() != tag:
                i += 1
            i += 1
    return "\n".join(out)


def allowed_target(path: str) -> bool:
    path = path.strip("'\"")
    return any(path.startswith(p) for p in ALLOWED_PREFIXES) or path == "/dev/null"


def find_violation(cmd: str):
    cmd = strip_quotes(strip_heredoc_bodies(cmd))
    for pat in IN_PLACE:
        if pat.search(cmd):
            return "in-place edit"
    for m in REDIRECT.finditer(cmd):
        if not allowed_target(m.group(1)):
            return f"redirect to {m.group(1)}"
    for m in TEE.finditer(cmd):
        targets = m.group(2).split()
        if any(not allowed_target(t) for t in targets):
            return "tee to file"
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command", "")
    why = find_violation(cmd)
    if not why:
        return 0
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Blocked ({why}). {REASON}",
            }
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
