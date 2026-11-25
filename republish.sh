#!/usr/bin/env bash
# 重发 folder-icons v1.0.0（含 PKMer 作者与新仓库名）
# 前置：token 写入 ../.github-token（classic + repo）
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TOKEN_FILE="${TOKEN_FILE:-../.github-token}"
API="https://api.github.com"
OWNER="juestchaos"
REPO="morz-folder-icons"
TAG="v1.0.0"

[ -f "$TOKEN_FILE" ] || { echo "✗ 缺少 token 文件：$TOKEN_FILE"; exit 1; }
TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || { echo "✗ token 为空"; exit 1; }

auth=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json"
      -H "Content-Type: application/json" -H "X-GitHub-Api-Version: 2022-11-28")
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=process.argv[1];try{const j=JSON.parse(s);const v=a.split(".").reduce((o,k)=>o&&o[k],j);console.log(v===undefined?"":(typeof v==="object"?JSON.stringify(v):v))}catch(e){console.log("")}})' "$1"; }

echo "1/8 校验 token …"
LOGIN="$(curl -sS --max-time 30 "${auth[@]}" "$API/user" | jget login)"
[ -n "$LOGIN" ] || { echo "✗ token 无效"; exit 1; }
echo "   $LOGIN"

echo "2/8 读取远端 main sha …"
REMOTE_SHA="$(curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/git/ref/heads/main" | jget object.sha)"
LOCAL_SHA="$(git rev-parse HEAD)"
echo "   远端 ${REMOTE_SHA:0:7}  本地 ${LOCAL_SHA:0:7}"

echo "3/8 删除远端旧 tag $TAG …"
DEL="$(curl -sS --max-time 30 "${auth[@]}" -X DELETE -o /dev/null -w '%{http_code}' "$API/repos/$OWNER/$REPO/git/refs/tags/$TAG")"
case "$DEL" in
  204) echo "   已删除" ;;
  422|404) echo "   远端本来就没有该 tag（$DEL）" ;;
  *) echo "   ⚠ 删除返回 $DEL，继续尝试" ;;
esac

echo "4/8 推送 main …"
AUTH_B64="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
GH=(git -c "http.extraheader=AUTHORIZATION: basic $AUTH_B64")
git remote remove origin >/dev/null 2>&1
git remote add origin "https://github.com/$OWNER/$REPO.git"
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  echo "   ⚠ 远端与本地分叉，用 --force-with-lease 限定覆盖 $REMOTE_SHA"
  PUSH=(push --force-with-lease=main:"$REMOTE_SHA" origin main)
else
  PUSH=(push origin main)
fi
"${GH[@]}" "${PUSH[@]}" 2>&1 | tail -3
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "✗ push main 失败"; exit 1; }

echo "5/8 推送 tag $TAG …"
"${GH[@]}" push origin "$TAG" 2>&1 | tail -3
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "✗ push tag 失败"; exit 1; }

echo "6/8 创建 Release $TAG …"
RBODY='{"tag_name":"v1.0.0","name":"v1.0.0","body":"## 文件夹图标 v1.0.0\n\n首个版本。\n\n- 文件树右键 → 插件 → 设置文件夹图标，光标处浮层选图标，即时生效\n- 内置 2102 个 Lucide 图标，支持英文与中文关键词搜索（如 `会议` → calendar）\n- 名称规则批量匹配：包含 / 开头是 / 正则\n- 支持图标颜色与三字角标；文件夹改名后图标跟随\n- 配置存插件私有存储，视图内「数据」页可导出 / 导入 JSON","draft":false,"prerelease":false}'
RURL="$(curl -sS --max-time 60 "${auth[@]}" -X POST "$API/repos/$OWNER/$REPO/releases" -d "$RBODY" | jget html_url)"
[ -n "$RURL" ] && echo "   $RURL" || echo "   ⚠ Release 未创建"

echo "7/8 确认 topic …"
TOPICS="$(curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/topics" | jget names)"
if printf '%s' "$TOPICS" | grep -q "morz-plugin"; then
  echo "   $TOPICS"
else
  TOPICS="$(curl -sS --max-time 30 "${auth[@]}" -X PUT "$API/repos/$OWNER/$REPO/topics" \
    -d '{"names":["morz-plugin","morz","markdown","productivity"]}' | jget names)"
  echo "   已补：$TOPICS"
fi

echo "8/8 校验 tag 内文件 …"
for f in manifest.json main.js; do
  curl -sS --max-time 60 "${auth[@]}" "$API/repos/$OWNER/$REPO/contents/$f?ref=$TAG" \
    | node -e 'const f=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const fs=require("fs"),crypto=require("crypto");
        const j=JSON.parse(s);
        if(!j.content){console.log("   "+f+" ✗ "+(j.message||"无内容"));return}
        const b=Buffer.from(j.content,"base64");
        const local=fs.readFileSync(f);
        const same=b.equals(local);
        console.log("   "+f+" 远端 "+b.length+"B / 本地 "+local.length+"B "+(same?"字节一致 ✓":"✗ 不一致"));
      })' "$f"
done
curl -sS --max-time 30 "${auth[@]}" "$API/repos/$OWNER/$REPO/contents/manifest.json?ref=$TAG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      const m=JSON.parse(Buffer.from(j.content,"base64").toString());
      console.log("   author="+m.author+"  id="+m.id+"  version="+m.version+"  icon="+m.icon)})'

echo
echo "=== 完成 ==="
echo "仓库   https://github.com/$OWNER/$REPO"
echo "Tag    https://github.com/$OWNER/$REPO/tree/$TAG"
echo "索引   官方扫描器每日 03:00 UTC 收录（北京时间 11:00），最长约 24h"
echo "自测   Morz → 设置 → 第三方插件 → 从仓库安装… → 输入 $OWNER/$REPO"
echo
echo "确认无误后删除 token：rm -f $TOKEN_FILE，并在 GitHub 上吊销"
