# 週間プランナー

React と Vite で作った、週間表示のプランナーです。

## ローカルで起動

```bash
npm install
npm run dev
```

## Googleカレンダー連携の設定

表示中の週の予定をGoogleカレンダーから読み込み、自作プランナーで作った予定をGoogleカレンダーにも追加できます。

1. Google Cloudでプロジェクトを作成します。
2. Google Calendar APIを有効にします。
3. APIキーを作成します。
4. OAuthのウェブクライアントIDを作成し、承認済みのJavaScript生成元に `http://localhost:5173` などのローカルURLを追加します。
5. `.env.example` を `.env.local` にコピーして、次の値を入れます。

```bash
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=your-google-api-key
```

`.env.local` を変更したあとは、開発サーバーを再起動してください。

## Supabaseクラウド保存の設定

PC版とスマホ版で同じ予定・タスク・メモ・設定を使うには、Supabaseで `events`、`tasks`、`memos`、`settings` テーブルを作成して、`.env.local` に次の値を追加します。

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

テーブル作成用SQLは [supabase-schema.sql](./supabase-schema.sql) にあります。`.env.local` を変更したあとは、開発サーバーを再起動してください。
