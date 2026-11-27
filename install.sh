#!/usr/bin/env bash
# coding-on-phone 安裝腳本：檢查工具、註冊開機自動啟動的使用者服務。
#   ./install.sh          檢查並安裝服務（缺的套件只會列出指令）
#   ./install.sh --apt    順便用 sudo apt-get 安裝缺的套件
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${COP_PORT:-8377}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! have python3 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))'; then
  echo "需要 Python 3.8 以上（sudo apt-get install python3）"; exit 1
fi

missing=()
have g++ || missing+=(g++)
have gcc || missing+=(gcc)
ls /usr/bin/clangd* >/dev/null 2>&1 || have clangd || missing+=(clangd)

say "== 工具檢查 =="
for c in python3 g++ gcc clangd; do
  if have "$c"; then echo "  ✓ $c"; else echo "  ✗ $c"; fi
done
if have pyright-langserver || have basedpyright-langserver || have pylsp || have jedi-language-server; then
  echo "  ✓ Python 語言伺服器"
else
  echo "  - Python 語言伺服器未安裝（選用；裝了才有 Python 語意補全：pipx install basedpyright）"
fi

if [ ${#missing[@]} -gt 0 ]; then
  if [ "${1:-}" = "--apt" ] && have apt-get; then
    say "== 安裝 ${missing[*]} =="
    sudo apt-get update && sudo apt-get install -y "${missing[@]}"
  else
    say "缺少：${missing[*]}"
    echo "  請執行：sudo apt-get install -y ${missing[*]}    （或重跑 ./install.sh --apt）"
    echo "  沒有 clangd 仍可使用，只是 C/C++ 補全會退回內建字詞。"
  fi
fi

mkdir -p data
if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  unit="$HOME/.config/systemd/user/coding-on-phone.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=coding-on-phone
After=network.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$(command -v python3) $ROOT/server/main.py --host 127.0.0.1 --port $PORT
Restart=on-failure
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now coding-on-phone.service
  systemctl --user restart coding-on-phone.service
  say "== 服務已啟動（127.0.0.1:$PORT）=="
  echo "  看狀態：systemctl --user status coding-on-phone"
  echo "  看記錄：journalctl --user -u coding-on-phone -f"
  echo "  沒登入也要常駐：sudo loginctl enable-linger $USER"
else
  say "== 找不到 systemd 使用者服務，請手動啟動 =="
  echo "  python3 $ROOT/server/main.py --port $PORT"
fi

say "== 接下來：讓 iPhone 連進來 =="
cat <<TXT
  1. 這台電腦安裝 Tailscale 並登入：
       curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
  2. iPhone 從 App Store 安裝 Tailscale，登入同一個帳號。
  3. 到 Tailscale 管理後台的 DNS 頁面，開啟 MagicDNS 與 HTTPS Certificates。
  4. 在這台電腦執行：
       sudo tailscale serve --bg $PORT
     它會印出一個 https://<機器名>.<tailnet>.ts.net 網址。
  5. iPhone 用 Safari 開那個網址 → 分享 → 加入主畫面。
TXT
