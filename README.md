# Google Maps 保存スポット移行補助（試験版）

**この版で実Google Mapsへの保存・移行はできません。入力の正規化と、保存しない試行（dry-run）を行う開発途中のツールです。**

preview10-candidate の処理コードを収録しています。実 Google 向け `run --execute` / `verify --execute` は `LIVE_DISABLED_UNVERIFIED_UI` で停止します。実画面の保存先判定を検証できていないため、安全ゲートを解除しないでください。公開・ダウンロード可能になっても、本番移行可能になった意味ではありません。

## ダウンロードと前提

GitHub の **Code → Download ZIP** でダウンロードして展開してください。Node.js 22.15 以上が必要です。追加 npm パッケージ、API キー、課金は不要です。Windows の PowerShell、macOS/Linux の端末で、展開したフォルダーへ移動して実行します。

## まず合成2件だけで試す

Google のアカウントや実データを使わず試せます。`state` に同名の出力がすでにあると上書きせず停止するので、初回用の新しいフォルダーで実行してください。

```sh
node --version
npm run test:offline
node src/cli.mjs normalize --input samples/synthetic-2.csv --output state/normalized.jsonl --report state/normalize-report.json
node src/cli.mjs run --input state/normalized.jsonl --journal state/journal.jsonl
```

最後の結果で `noBrowserStarted: true` と `noGoogleRequestSent: true` を確認します。これは保存件数の成功確認ではなく、入力の試験です。

## 自分の Takeout 出力を確認する場合

Google Takeout からの取得は、そのアカウントを操作する権限のある本人が公式画面で行います。ツールがログイン情報を読み取ったり、データをダウンロードしたりすることはありません。

```sh
node src/cli.mjs normalize --input old-export --output state/my-normalized.jsonl --report state/my-normalize-report.json
node src/cli.mjs run --input state/my-normalized.jsonl --journal state/my-journal.jsonl
```

CSV / GeoJSON の対応範囲は [形式の注意点](docs/FORMAT_NOTES.md) を参照してください。短縮 URL、名称だけの場所、曖昧な ID は自動対象にせず、要確認として残します。GeoJSON を Starred places と確認できる場合のみ `--geojson-kind starred` が使えます。レビューなど別種のデータを指定しないでください。

`normalize-report.json` の件数、重複、要確認の理由を自分で照合してください。元ファイルは変更・削除しません。実エクスポート、生成した state、専用ブラウザープロファイル、Cookie、認証情報、個人の保存スポットは GitHub や他人へアップロードしないでください。

## 収録と検証範囲

- `src/`: ローカルの正規化、重複判定、再開履歴、安全ガード、開発用ブラウザーアダプターと模擬サーバー。
- `samples/`: 架空の場所だけの合成 CSV（2件 / 1000件）。実在アカウント・個人の保存スポットは含めません。
- `test/`: 合成データとスタブによる検証。公開準備時のオフライン試験は 148 / 148 成功。
- `npm test` はブラウザーを起動する開発用試験です。今回再実行していません。通常利用では上記 `test:offline` だけを使ってください。
- 実 Google 保存、Windows/macOS 実機での今回の再検証は未実施です。
- `login` は専用プロファイルへ本人が手動ログインする開発向けコマンドで、保存・移行機能ではありません。dry-run のためには不要です。

この公開パッケージには過去の Git 履歴や作業用の個人情報を含めず、ソース・合成試験・一般的な手順だけを収録しています。MIT License。Google の公式製品ではありません。
