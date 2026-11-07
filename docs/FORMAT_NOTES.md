# 形式・公式仕様メモ（2026-10-11）

## 確認できた一次資料

| 対象 | 公式資料から確認できること | 実装上の扱い |
|---|---|---|
| Googleデータの取得 | Google Takeoutで利用中サービスのデータを選び、アーカイブを作成・ダウンロードできる。直近変更が含まれない場合もある | 入力取得は本人が行う。ツールはTakeoutへログインしない |
| Data Portability `Saved` | CSV列は `title`, `item_content_url`, `note`, `tags`, `comment`。任意の `collection_description` が先頭行＋空行に置かれる。各データは欠け得る | ヘッダー位置を先頭8行から明示検出。URL欠落は要確認 |
| Maps local actions | Starred places等は GeoJSON。Point座標は `[longitude, latitude]`。`[0,0]` は不明になり得る | 経緯度順を逆転しない。`[0,0]` は使用しない |
| Maps URLs | `api=1` の検索URLで `query_place_id` を併用でき、Place IDが場所の特定に有効。APIキー不要 | exact Place IDがあるときのURLを保存 |
| 通常の保存操作 | 場所を開き Save → listを選択。Saved Listsは3,000件まで | 公開UIのみを操作し、保存先のchecked状態を確認 |
| 自動ブラウザーのログイン | Googleは自動制御ブラウザーでのログインを拒否する場合がある | 拒否時は停止。回避策を実装しない |

一次資料:

- <https://support.google.com/accounts/answer/3024190?hl=en>
- <https://developers.google.com/data-portability/schema-reference/save>
- <https://developers.google.com/data-portability/schema-reference/local_actions>
- <https://developers.google.com/maps/documentation/urls/get-started>
- <https://support.google.com/maps/answer/3184808?co=GENIE.Platform%3DDesktop&hl=en>
- <https://support.google.com/accounts/answer/7675428?hl=en>

## 断定しないこと

- Data Portability schema と、全ユーザーが現在受け取る Takeout ファイルが常に完全同一とは断定しない。
- `Saved` と `Maps (your places)` を同じexportとは扱わない。
- 旧公開例にある `Title,Note,URL,Comment` CSVは互換入力として扱うが、現行公式schemaだとは表現しない。
- GeoJSONであるだけでは Maps Saved と判断しない。`FeatureCollection` かつ exact Google Maps URLを取得できるものだけを自動候補にする。
- Maps Grounding Lite の保存用リンク生成機能を、通常 Saved リストへの直接書込みAPIとは扱わない。
- Google Maps保存先への公式一括importが「絶対に存在しない」とは断定しない。今回確認した公式手順には見つからなかった、と限定する。

## URL判定

自動候補:

- `https://*.google.<tld>/maps/...` の exact URL
- `query_place_id`, `place_id`, `cid`, `ludocid`, `ftid`, Maps data ID のいずれかを取り出せるもの

要確認:

- `maps.app.goo.gl` / `goo.gl`（ネットワークで勝手に展開しない）
- 外部ドメイン、HTTP、`file:`, `javascript:`
- IDのない一般検索URL
- 名称のみ、欠損URL
- 座標のみ（明示opt-in時を除く）
- `[0,0]` や範囲外座標

## preview8候補: CSV入力境界（2026-10-14、合成入力のみ）

- 未引用セル内の引用符、閉じ引用符の後の区切り以外の文字、閉じていない引用符を拒否します。引用符を取り除いて別のURL/IDに補正しません。
- 大文字小文字・周囲空白を正規化して同名となる非空ヘッダーは拒否します。ヘッダーのない非空列も拒否し、無言で破棄しません。
- 既存互換性として、末尾セルの省略は空値、末尾の余分な完全空セルは無視します。途中セルの欠落と意図的な空値をCSVだけから復元することはできません。曖昧な入力を自動修復する機能ではありません。
- UTF-8 BOMはファイル先頭の1個だけを除きます。LF/CRLF/CRのレコード区切りに対応し、引用されたセル内の改行は保持します。CRのみの区切り対応は互換性の追加であり、従来版では拒否されていました。
- sourceIndex は空レコードを含む1始まりのCSVレコード番号です。複数物理行にわたる引用セルでは物理行番号と異なります。従来の空行除去後の誤った番号付けを修正しました。
- 空白だけのデータレコードは従来どおり無視します。異なる別名ヘッダー（例: url と item_content_url）の優先順位や未知の名前付き列の扱いは従来どおりです。すべてのTakeout形式を検証済みとはしません。
- 構造エラー時は正規化出力・レポートを書き出す前に停止します。実Google Mapsへの保存・検証gateは引き続き無効です。
