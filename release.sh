#!/usr/bin/env bash
# 发布 / 重发当前版本：读 manifest.json 的 version，推送 main + 打 tag + 建 Release + 校验字节
# 用法： ./release.sh [-n 说明文件]      说明文件默认用 RELEASE_NOTES.md（可缺省）
# 凭据： GITHUB_TOKEN 环境变量，或 ../.github-token（classic PAT，需 repo 权限）
# 跑完请删除 token 文件并在 GitHub 上吊销
set -uo pipefail
cd "$(dirname "$0")" || exit 1

NOTES_FILE="RELEASE_NOTES.md"
while getopts "n:" o; do case "$o" in n) NOTES_FILE="$OPTARG" ;; *) exit 1 ;; esac; done

API="https://api.github.com"
OWNER="juestchaos"
REPO="morz-folder-icons"
VERSION="$(node -p "require('./manifest.json').version")"
TAG="v$VERSION"
TOKEN_FILE="${TOKEN_FILE:-../.github-token}"

if [ -n "${GITHUB_TOKEN:-}" ]; then TOKEN="$GITHUB_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
else echo "✗ 没有凭据：设置 GITHUB_TOKEN，或把 PAT 写入 $TOKEN_FILE"; exit 1; fi
[ -n "$TOKEN" ] || { echo "✗ token 为空"; exit 1; }

auth=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json"
      -H "Content-Type: application/json" -H "X-GitHub-Api-Version: 2022-11-28")
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=process.argv[1];try{const j=JSON.parse(s);const v=a.split(".").reduce((o,k)=>o&&o[k],j);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"; }
post() { curl -sS --max-time 60 "${auth[@]}" -X POST "$@"; }

NOTES="$( [ -f "$NOTES_FILE" ] && cat "$NOTES_FILE" )"
[ -n "$NOTES" ] || NOTES="v$VERSION"
RBODY="$(node -e 'const [t,v,n]=process.argv.slice(1);console.log(JSON.stringify({tag_name:t,name:t,body:n,draft:false,prerelease:false}))' "$TAG" "$VERSION" "$NOTES")"

echo "1/8 校验 token（目标 $OWNER/$REPO $TAG）…"
LOGIN="$(curl -sS --max-time 30 "${auth[@]}" "$API/user" | jget login)"
[ -n "$LOGIN" ] || { echo "✗ token 无效或无 repo 权限"; exit 1; }
echo "   $LOGIN"

echo "2/8 本地构建与版本号 …"
[ -f main.js ] || { echo "✗ 缺 main.js，先跑 node build.js"; exit 1; }
echo "   manifest $VERSION   main.js $(wc -c < main.js) B   sha256 $(node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync("main.js")).digest("hex").slice(0,12))')"

echo "3/8 清理同名 tag / Release …"
RID="$(curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/releases/tags/$TAG" | jget id)"
if [ -n "$RID" ]; then
  curl -sS --max-time 30 "${auth[@]}" -X DELETE -o /dev/null -w '   Release 已删除（%{http_code}）\n' "$API/repos/$OWNER/$REPO/releases/$RID"
fi
DEL="$(curl -sS --max-time 30 "${auth[@]}" -X DELETE -o /dev/null -w '%{http_code}' "$API/repos/$OWNER/$REPO/git/refs/tags/$TAG")"
case "$DEL" in 204) echo "   远端 tag 已删除" ;; 404|422) echo "   远端无该 tag" ;; *) echo "   ⚠ 删 tag 返回 $DEL" ;; esac

echo "4/8 推送 main …"
REMOTE_SHA="$(curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/git/ref/heads/main" | jget object.sha)"
LOCAL_SHA="$(git rev-parse HEAD)"
AUTH_B64="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
GH=(git -c "http.extraheader=AUTHORIZATION: basic $AUTH_B64")
if [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then
  echo "   远端已是最新 ${LOCAL_SHA:0:7}"
else
  PUSH=(push origin main)
  [ -n "$REMOTE_SHA" ] && PUSH=(push --force-with-lease=main:"$REMOTE_SHA" origin main) \
    && echo "   远端 ${REMOTE_SHA:0:7} ≠ 本地 ${LOCAL_SHA:0:7}，--force-with-lease 覆盖"
  "${GH[@]}" "${PUSH[@]}" 2>&1 | tail -2
  [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "✗ push main 失败"; exit 1; }
fi

echo "5/8 打 tag $TAG …"
git tag -f -a "$TAG" -m "morz-folder-icons $TAG" >/dev/null
"${GH[@]}" push -f origin "$TAG" 2>&1 | tail -2
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "✗ push tag 失败"; exit 1; }

echo "6/8 创建 Release …"
RURL="$(post "$API/repos/$OWNER/$REPO/releases" -d "$RBODY" | jget html_url)"
[ -n "$RURL" ] && echo "   $RURL" || { echo "✗ Release 创建失败"; exit 1; }

echo "7/8 确认 topic …"
TOPICS="$(curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/topics" | jget names)"
if printf '%s' "$TOPICS" | grep -q "morz-plugin"; then echo "   $TOPICS"
else
  TOPICS="$(curl -sS --max-time 30 "${auth[@]}" -X PUT "$API/repos/$OWNER/$REPO/topics" \
    -d '{"names":["morz-plugin","morz","markdown","productivity"]}' | jget names)"
  echo "   已补：$TOPICS"
fi

echo "8/8 校验 tag 内文件字节 …"
for f in manifest.json main.js; do
  curl -sS --max-time 60 "${auth[@]}" "$API/repos/$OWNER/$REPO/contents/$f?ref=$TAG" \
    | node -e 'const f=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const fs=require("fs");
        const j=JSON.parse(s);
        if(!j.content){console.log("   "+f+" ✗ "+(j.message||"无内容"));return}
        const b=Buffer.from(j.content,"base64");
        const local=fs.readFileSync(f);
        console.log("   "+f+" 远端 "+b.length+"B / 本地 "+local.length+"B "+(b.equals(local)?"字节一致 ✓":"✗ 不一致"));
      })' "$f"
done
curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/contents/manifest.json?ref=$TAG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      const m=JSON.parse(Buffer.from(j.content,"base64").toString());
      console.log("   id="+m.id+"  version="+m.version+"  author="+m.author+"  icon="+m.icon)})'

echo
echo "=== 完成 ==="
echo "仓库   https://github.com/$OWNER/$REPO"
echo "Tag    https://github.com/$OWNER/$REPO/tree/$TAG"
echo "索引   扫描器每日 03:00 UTC 收录（北京时间 11:00），最长约 24h"
echo "自测   Morz → 设置 → 第三方插件 → 从仓库安装… → 输入 $OWNER/$REPO"
echo
echo "确认无误后删除 token：rm -f $TOKEN_FILE，并在 GitHub 上吊销"
