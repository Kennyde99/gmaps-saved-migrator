# Google Maps 保存場所を別アカウントへコピー

**v0.2.0 live-pilot：自分の Takeout データを読み、移行先の通常 Google Maps 画面で実際に「保存」を押す経路を追加しました。ダミーデータ専用ではありません。**

ただし **実 Google アカウントでの一連の動作は未検証です**。初回は最大2件、画面上のアカウント・場所・保存先を確認できた場合だけ実行し、別ページへ移動した後に再読込して保存を確認します。Google UIが対応形状でない場合は保存せず停止します。動作保証済みの完成版・公式APIによる直接移行ではありません。

## できることとできないこと

- 旧アカウントから **Google Takeoutを本人が取得** → ローカルでCSV/GeoJSONを正規化 → 新アカウントへ本人が専用ブラウザーでログイン → 新しい非公開リストへ場所を追加。
- 元のアカウント・保存場所を削除しない「コピー」です。パスワードやCookieを.envへ入力する方式ではありません。
- 同一入力・移行先アカウント・リストに処理履歴を固定。既に保存済みの場所は解除せず、保存直後だけでなく別ナビゲーションで確認。最初の2件の承認後も1回25件です。
- **取得元のオンライン直接読出し、リスト分類/メモ/ラベル/写真の自動転記、短縮URLの自動解決は未対応**。複数リストを入力すると一つの移行専用リストへ統合されます。リストごとに移したい場合は入力と `GMAPS_STATE` と保存先リストを分けます。
- APIキーを登録しても個人の保存リストに書き込めません。公開Places APIは検索/場所情報用です。
- CAPTCHA、403/429、ログイン拒否、想定外UIでは停止。再試行の連打、非公開API、認証回避、ガード解除はしません。

## ダウンロード

このページの **Code → Download ZIP** でダウンロードして展開。Node.js **22.15以上**と通常版Chrome/Edgeが必要です。APIキー・追加npmパッケージ・課金は不要です。PowerShellで展開先へ移動します。

## 1. 実データを用意

1. 移行元アカウントの本人が [Google Takeout](https://takeout.google.com/) へログインします。
2. 保存リストに対応する「保存済み / Saved」と、必要なら「マップ（マイプレイス）」を選択。項目名や形式はアカウントにより異なります。
3. ZIPを取得・展開し、移したいリストのCSVを選びます。Takeout未出力の場所は取得できていないものとして残します。
4. 実データはGitHubへアップロードしません。[対応形式](docs/FORMAT_NOTES.md)も確認してください。

## 2. 後からアカウントを設定（PowerShell）

以下は識別用メールであり認証情報ではありません。**パスワード・認証コード・Cookie・トークンをコードや環境変数へ保存しないでください。** アカウントの所有者が、各ブラウザー画面でログインします。

```powershell
$env:GMAPS_SOURCE_ACCOUNT = "old@example.com"
$env:GMAPS_TARGET_ACCOUNT = "new@example.com"
$env:GMAPS_TARGET_LIST = "GMAPS-MIGRATION-2026"
$env:GMAPS_INPUT = "C:\path\to\Takeout\Saved\your-list.csv"
$env:GMAPS_STATE = "state/transfer"
$env:GMAPS_PROFILE = "private/target-profile"
# 自動検出されない時だけ設定
# $env:GMAPS_BROWSER = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

macOS/Linuxでは `$env:NAME = "value"` の代わりに `export NAME="value"` と設定し、入力パスを変更します。`.env` ファイルは自動読込しません。Nodeの `--env-file` を使う場合もパスワードは記載しないでください。

## 3. まず実データ2件

```powershell
npm run test:offline
npm run transfer -- prepare
npm run transfer -- login
npm run transfer -- pilot
npm run transfer -- verify
```

- `prepare` は移行元の確認を求めます。元アカウントとのオンライン照合ではなく本人確認です。`state/transfer/normalize-report.json` の要確認・除外・重複を読んでください。
- `login` で開く専用ブラウザーに **新アカウントだけ**でログインし、保存先名と同じ **非公開の新規リスト**を作成。本人の画面上で確認してから端末に戻りEnterを押します。ログインを拒否されたら停止します。通常ChromeのCookieをコピーしないでください。
- `pilot` は対象アカウントとリスト名を入力確認してから、実データの最初の最大2件を保存します。全一覧のチェック状態が読めない、場所IDが正確に一致しない場合は停止します。
- `verify` は初回試行の実保存を再確認します。対象外の既存リストが保持されていることも確認します。
- 新アカウントのGoogle Mapsで実際にその2件が入ったことを本人が確認します。`savedVerified` が0、`stopReason`がある、途中終了の場合は完了ではありません。

## 4. 2件が確認できた後だけ続行

```powershell
npm run transfer -- approve
npm run transfer -- batch
npm run transfer -- status
```

`approve` は実保存2件の本人確認を求めます。`batch` は残りから最大25件を追加し、毎回再読込を行います。正常終了後に同じ `batch` を繰り返せます。`status` はローカル履歴の集計で、新しいGoogle照合ではありません。

- 中断したら **stateと専用profileを消さずに**保持してください。不確定な保存は次回に実画面で確認してから処理します。
- 入力/アカウント/保存先を変える場合は別 `GMAPS_STATE` を使います。別アカウントには別 `GMAPS_PROFILE`。
- `prepare` / `verify` / `approve` は既存ファイルを上書きしません。再検証が必要なら低水準CLIで新しい検証ファイルを指定するか、元ファイルをバックアップした上で確認します。安易に履歴を消してやり直さないでください。
- 全件完了は `remaining: 0` だけで判断せず、正規化段階の `manualReview` / 除外も照合。要確認は勝手に移行した扱いにしません。

## 検証範囲・既知の限界

オフライン試験155件が成功。合成データで正規化・スコープ固定・再開・二重保存防止・実行同意・2件制限・アカウント誤一致防止・場所IDの厳密比較をテストしています。今回の環境ではChromium起動がローカルソケット制限で失敗し、ブラウザー結合試験は完走できていません。**合成試験の合格はGoogle実画面の動作保証ではありません**。日本語/英語の対応メニュー以外、名前だけの場所、画面URLで同一場所を確証できないIDは停止します。Chrome更新やGoogleのUI変更で停止することがあります。

`src/cli.mjs` の低水準実行は `run --execute --live` が必要です。既定はdry-run、実行同意を環境変数で自動付与しません。元のエクスポート、認証情報、実データは公開しないでください。`.gitignore` は `.env`、`state/`、`private/`、`old-export/` を除外します。

## 公式根拠（2026-11-07確認）

- [場所をリストに保存する手順](https://support.google.com/maps/answer/7280933?co=GENIE.Platform%3DDesktop&hl=ja)：通常UIの保存・非公開/共有設定。
- [保存済み場所](https://support.google.com/maps/answer/3184808?co=GENIE.Platform%3DDesktop&hl=ja)：リスト上限3,000件。約1,000件でも小分けで確認してください。
- [Places APIメソッド一覧](https://developers.google.com/maps/documentation/places/web-service/reference/rest)：個人の保存リストへの書込APIではありません。

本ツールのUI自動化がGoogle公式に認定されているという意味ではありません。利用時はGoogleの規約と画面指示に従ってください。MIT License。
