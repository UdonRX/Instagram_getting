# Instagram_getting

Instagramの公開プロフィール・投稿・Reelsを、Instagram本体をスクレイピングせずにMeta公式のtokenless oEmbedで表示できるか確認するための独立試作です。

## 今回の目的

new-wnt-gettingへ組み込む前に、特にPersonal公開アカウントについて以下を確認します。

- `https://www.instagram.com/{username}/` のProfile Embedが表示できるか
- Profile Embed内で最近の投稿・Reelsが実用的に確認できるか
- iPhone Safari / PWA相当の縦画面で崩れないか
- 投稿URL `/p/{shortcode}/` とReels `/reel/{shortcode}/` も表示できるか
- 再取得時に新着内容が更新されるか

## 仕組み

1. ブラウザからInstagramユーザー名または公開URLを入力
2. Vercel Function `api/embed.mjs` が入力をInstagram公開URLだけに制限
3. Meta公式 `https://graph.facebook.com/v25.0/instagram_oembed` へtokenlessで問い合わせ
4. 返ってきたEmbed HTMLを表示
5. フロントではInstagram公式 `https://www.instagram.com/embed.js` を読み込み描画

Meta公式の2026年版 Meta Embeds for WordPress でも、Instagramの投稿・Reels・プロフィールURLに対して同じtokenless oEmbed endpointを利用しています。

## Vercel環境変数

### この試作では不要

現時点では環境変数は1つも必要ありません。

- Instagramユーザー名 / パスワード: 不要
- Meta App ID: 不要
- Meta App Secret: 不要
- Access Token: 不要

### 将来Business / Creator判定を追加するときだけ必要になる候補

この試作の結果が良ければ、次段階でMeta Graph API Business Discoveryを追加します。そのときは例として以下をVercel Environment Variablesへ保存します。

- `META_ACCESS_TOKEN`
- `META_IG_USER_ID`

これらはGitHubへ直接書かず、Vercel側のSecretとして管理します。

## 対応入力

- `@username`
- `username`
- `https://www.instagram.com/username/`
- `https://www.instagram.com/p/SHORTCODE/`
- `https://www.instagram.com/reel/SHORTCODE/`

Stories、非公開アカウント、Instagram以外のURLは対象外です。

## データ保存

登録したテスト対象はブラウザの`localStorage`にだけ保存します。サーバー側DB、Redis、Instagram Cookie等は使いません。

## 構成

- `index.html` — 試験画面
- `styles.css` — iPhone向けUI
- `app.js` — 登録、localStorage、Embed描画、診断表示
- `api/embed.mjs` — Meta公式oEmbedへの安全なプロキシ
- `vercel.json` — Vercel設定
