"""公式のカード本文・画像・裏面・おすすめデッキでdata全体を再生成する。"""
import argparse
import copy
import json
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

import pymupdf
import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

PROJECT_DIR = Path(__file__).resolve().parents[2]
OUTPUT_DIR = PROJECT_DIR / "data"
CARD_TYPES = ("holomen", "oshi_holomen", "support", "yell")
CARD_FILES = {kind: OUTPUT_DIR / (kind + ".json") for kind in CARD_TYPES}
IMAGE_DIR = OUTPUT_DIR / "card_images"
OFFICIAL_ROOT = "https://hololive-official-cardgame.com"
SEARCH_URL = OFFICIAL_ROOT + "/cardlist/cardsearch/?view=text"
PAGE_URL = OFFICIAL_ROOT + "/cardlist/cardsearch_ex?view=text&page="
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36"
CARD_NUMBER = re.compile(r"h[A-Z]{1,3}(?:\d{2})?-\d{3}")
IMAGE_FILENAME = re.compile(r"(" + CARD_NUMBER.pattern + r")(?:_\d+)?\.png")
COLORS = "白緑赤青紫黄無"


def normalize_text(value):
    return value.translate(str.maketrans("０１２３４５６７８９", "0123456789")).replace("holox", "holoX")


def recursive_normalize(data):
    if isinstance(data, dict):
        return {key: recursive_normalize(value) for key, value in data.items()}
    if isinstance(data, list):
        return [recursive_normalize(value) for value in data]
    return normalize_text(data) if isinstance(data, str) else data


def write_json(data, output_path):
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_session():
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    retry = Retry(total=3, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def require_official_url(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != urlparse(OFFICIAL_ROOT).hostname:
        raise ValueError("公式以外の取得URL: " + url)


def get_soup(url, session=None):
    require_official_url(url)
    if session is None:
        with create_session() as own_session:
            return get_soup(url, own_session)
    response = session.get(url, timeout=30)
    response.raise_for_status()
    response.encoding = "utf-8"
    return BeautifulSoup(response.text, "html.parser")


def text(node):
    return normalize_text("".join(node.stripped_strings)) if node else ""


def icons(node):
    return [img.get("alt", "").replace("◇", "無") for img in node.select("img")] if node else []


def info_fields(block):
    fields = {}
    for dt in block.select(".info dt"):
        dd = dt.find_next_sibling("dd")
        if dd is None:
            raise ValueError("公式カードの項目に値がありません: " + text(dt))
        fields[text(dt)] = dd
    return fields


def required(fields, key):
    if key not in fields:
        raise ValueError("公式カードの必須項目がありません: " + key)
    return fields[key]


def paragraph(block):
    paragraphs = block.find_all("p", recursive=False)
    if len(paragraphs) != 2:
        raise ValueError("公式カードの能力欄を解釈できません")
    return paragraphs[1]


def without_heading(body):
    # 効果名・コストを本文に混ぜない。元のHTMLは変更しない。
    body = copy.deepcopy(body)
    heading = body.find("span", recursive=False)
    if heading:
        heading.decompose()
    return text(body)


def parse_skill_cost_and_name(value):
    match = re.fullmatch(r"\[ホロパワー[:：][-－−]?(\d+|[XxＸｘ])\](.*)", normalize_text(value), re.DOTALL)
    if not match:
        raise ValueError("公式推しスキルのコストを解釈できません: " + value)
    cost = match.group(1)
    return {"cost": int(cost) if cost.isdecimal() else "X", "name": match.group(2).strip()}


def parse_official_card(block):
    """テキスト一覧の1件を既存のゲーム用JSON形式へ変換する。"""
    number_node = block.select_one(".number")
    number = text(number_node.find("span") or number_node) if number_node else ""
    if number == "null":
        # カードナンバーのないデッキ構築説明用カード。
        return None
    if not CARD_NUMBER.fullmatch(number):
        raise ValueError("未知の公式カードナンバー: " + number)
    name = text(block.select_one(".name"))
    if not name:
        raise ValueError("公式カード名がありません: " + number)
    fields = info_fields(block)
    kind = text(required(fields, "カードタイプ"))
    colors = list("".join(icons(fields.get("色"))))
    extra_block = block.select_one(".extra")
    extra = text(paragraph(extra_block)) if extra_block else ""
    tag_node = fields.get("タグ")
    tag_text = tag_node.get_text(" ", strip=True) if tag_node else ""
    tags = [normalize_text(tag.strip()) for tag in tag_text.split("#") if tag.strip()]
    rarity = text(required(fields, "レアリティ"))
    if not rarity:
        raise ValueError("公式カードのレアリティが空です: " + number)
    data = {"id": number, "name": name, "rarity": rarity}
    if kind == "推しホロメン":
        root = "oshi_holomen"
        if len(colors) != 1:
            raise ValueError("推しホロメンの色を解釈できません: " + number)
        data.update(life=int(text(required(fields, "LIFE"))), color=colors[0],
                    oshi_stage_skill={}, oshi_skill={}, sp_oshi_skill={})
        for skill in block.select(".skill"):
            body = paragraph(skill)
            heading = body.find("span", recursive=False)
            if not heading:
                raise ValueError("推しスキル名がありません: " + number)
            classes = skill.get("class", [])
            if "stage" in classes:
                value = {"name": text(heading), "description": without_heading(body)}
                key = "oshi_stage_skill"
            else:
                cost_text = "".join(str(node) for node in body.contents[:body.contents.index(heading)])
                value = parse_skill_cost_and_name(text(BeautifulSoup(cost_text, "html.parser")) + text(heading))
                value["description"] = re.sub(r"^\[ホロパワー[:：][-－−]?(?:\d+|[XxＸｘ])\]", "", without_heading(body))
                key = "sp_oshi_skill" if "sp" in classes else "oshi_skill"
            data[key] = value
        if not data["oshi_skill"]:
            raise ValueError("公式の推しスキルがありません: " + number)
    elif kind in ("ホロメン", "Buzzホロメン"):
        root = "holomen"
        bloom = text(required(fields, "Bloomレベル"))
        if kind == "Buzzホロメン" or re.search(r"ダウンした時、自分のライフ-2", extra):
            bloom += "Buzz"
        data.update(bloom=bloom, color=colors, hp=int(text(required(fields, "HP"))),
                    bloom_effect={}, collab_effect={}, gift={}, arts=[], extra=extra,
                    tags=tags, baton_touch=icons(required(fields, "バトンタッチ")))
        for effect in block.select(".keyword"):
            body = paragraph(effect)
            heading = body.find("span", recursive=False)
            image = heading.find("img") if heading else None
            label = image.get("alt") if image else None
            key = {"ブルームエフェクト": "bloom_effect", "コラボエフェクト": "collab_effect", "ギフト": "gift"}.get(label)
            if key is None:
                raise ValueError("未知のキーワード: " + str(label))
            data[key] = {"name": text(heading), "description": without_heading(body)}
        for art in block.select(".arts"):
            body = paragraph(art)
            heading = body.find("span", recursive=False)
            if heading is None:
                raise ValueError("アーツ名がありません: " + number)
            special = heading.select_one(".tokkou")
            special_attack = {}
            if special and (text(special) or icons(special)):
                value = "".join(icons(special)) + text(special)
                power = re.fullmatch(r"([白緑赤青紫黄])\+(\d+)", value)
                if not power:
                    raise ValueError("色特攻を解釈できません: " + number)
                special_attack = {"target": power.group(1), "power": power.group(2)}
            heading_copy = copy.deepcopy(heading)
            if heading_copy.select_one(".tokkou"):
                heading_copy.select_one(".tokkou").decompose()
            cost = icons(heading_copy)
            value = text(heading_copy)
            match = re.fullmatch(r"(.+?)[\s　]+(\d+[+±]?)", value)
            if not match:
                # 一部の公式欄はアーツ名と威力の間の全角空白がない。
                match = re.fullmatch(r"(.+?)(\d+[+±]?)", value)
            if not match:
                raise ValueError("アーツ名・威力を解釈できません: " + number + ": " + value)
            data["arts"].append({"name": match.group(1), "cost": cost, "power": match.group(2),
                                 "description": without_heading(body), "special_attack": special_attack})
        if not data["arts"]:
            raise ValueError("公式のアーツがありません: " + number)
    elif kind.startswith("サポート・"):
        root = "support"
        subtype = kind.split("・")
        data.update(card_type=subtype[1], limited="LIMITED" in subtype,
                    description=re.split(r"LIMITED[:：]", text(required(fields, "能力テキスト")))[0].strip(),
                    extra=extra, tags=tags)
    elif kind == "エール":
        root = "yell"
        data["color"] = colors
    else:
        raise ValueError("未知の公式カードタイプ: " + kind)
    if root in ("holomen", "yell") and (not colors or any(color not in COLORS for color in colors)):
        raise ValueError("公式カードの色を解釈できません: " + number)
    image = block.select_one(".img img")
    if not image or not image.get("src"):
        raise ValueError("公式カード画像がありません: " + number)
    image_url = urljoin(OFFICIAL_ROOT, image["src"])
    if urlparse(image_url).hostname != urlparse(OFFICIAL_ROOT).hostname:
        raise ValueError("公式以外のカード画像URL: " + image_url)
    return root, recursive_normalize(data), image_url


def parse_official_page(soup):
    entries = soup.select("li:has(.center-Txtarea .number)")
    if not entries:
        raise ValueError("公式のカード一覧が空、またはHTML形式が変わっています")
    return [card for entry in entries if (card := parse_official_card(entry)) is not None]


def max_page(soup):
    scripts = "\n".join(script.get_text() for script in soup.select("script"))
    match = re.search(r"var\s+max_page\s*=\s*(\d+)", scripts)
    if not match or int(match.group(1)) < 1:
        raise ValueError("公式一覧のページ数を取得できません")
    return int(match.group(1))


def merge_official_cards(entries):
    results = {kind: {kind: []} for kind in CARD_TYPES}
    seen = {}
    image_urls = {}
    image_rarities = {}
    for kind, data, image_url in entries:
        data = copy.deepcopy(data)
        rarity = data.pop("rarity")
        if image_url in image_rarities and image_rarities[image_url] != rarity:
            raise ValueError("同じ公式画像のレアリティが一致しません: " + image_url)
        image_rarities[image_url] = rarity
        card_id = data["id"]
        if card_id in seen:
            old_kind, old_data = seen[card_id]
            if old_kind != kind or old_data != data:
                raise ValueError("同じカード番号の公式本文が一致しません: " + card_id)
        else:
            seen[card_id] = (kind, data)
            results[kind][kind].append(data)
        urls = image_urls.setdefault(card_id, [])
        if image_url not in urls:
            urls.append(image_url)
    manifest = []
    for card_id, (kind, data) in seen.items():
        data["images"] = []
        data["image_rarities"] = {}
        urls = image_urls[card_id]
        if kind == "yell":
            # 同番号の定型文なし再録版は使わず、通常版を採用する。
            urls = [min(urls, key=lambda url: primary_print_priority((kind, data, url)))]
        for index, url in enumerate(urls, 1):
            suffix = "" if index == 1 else "_" + str(index)
            filename = card_id + suffix + ".png"
            data["images"].append(filename)
            data["image_rarities"][filename] = image_rarities[url]
            manifest.append({"url": url, "filename": filename})
    return results, manifest


def collect_official_cards(limit=None):
    entries = []
    detail_urls = {}
    with create_session() as session:
        first = get_soup(SEARCH_URL, session)
        pages = max_page(first)
        count = text(first.select_one(".cardlist-Result_Target_Num .num")).replace(",", "")
        if not count.isdecimal():
            raise ValueError("公式一覧の検索件数を取得できません")
        listed = 0
        for page in range(1, pages + 1):
            if page > 1:
                time.sleep(0.1)
            soup = first if page == 1 else get_soup(PAGE_URL + str(page), session)
            listed += len(soup.select("li:has(.center-Txtarea .number)"))
            entries.extend(parse_official_page(soup))
            for node in soup.select("li:has(.center-Txtarea .number)"):
                link = node.select_one("a[href]")
                image = node.select_one(".img img[src]")
                if link and image:
                    params = parse_qs(urlparse(link["href"]).query)
                    if "id" in params:
                        detail_urls[urljoin(OFFICIAL_ROOT, image["src"])] = (
                            OFFICIAL_ROOT + "/cardlist/?id=" + params["id"][0] + "&view=text"
                        )
            print(f"公式一覧: {page}/{pages}", flush=True)
            if limit is not None and len({data["id"] for _, data, _ in entries}) >= limit:
                break
        if limit is None and listed != int(count):
            raise ValueError(f"公式一覧の検索件数と取得件数が一致しません: {count} / {listed}")
        groups = {}
        for entry in entries:
            groups.setdefault(entry[1]["id"], []).append(entry)
        if limit is not None:
            groups = dict(list(groups.items())[:limit])
        canonical = {}
        for index, (card_id, variants) in enumerate(groups.items(), 1):
            chosen = min(variants, key=primary_print_priority)
            time.sleep(0.1)
            soup = get_soup(detail_urls[chosen[2]], session)
            block = soup.select_one(".cardlist-Detail_Box_Inner")
            if block is None:
                raise ValueError("公式詳細のHTML形式が変わっています: " + card_id)
            parsed = parse_official_card(block)
            if parsed is None or parsed[0] != chosen[0] or parsed[1]["id"] != card_id:
                raise ValueError("公式一覧と詳細のカード番号・種別が一致しません: " + card_id)
            canonical[card_id] = parsed
            print(f"公式詳細: {index}/{len(groups)} {card_id}", flush=True)
        # 再録・パラレルの表記差をゲーム本文へ混ぜず、画像の採否はmergeで決める。
        entries = [(canonical[card_id][0], {**copy.deepcopy(canonical[card_id][1]),
                                          "rarity": variant[1]["rarity"]}, variant[2])
                   for card_id, variants in groups.items() for variant in variants]
    return merge_official_cards(entries)


def primary_print_priority(entry):
    path = Path(urlparse(entry[2]).path)
    prefix = entry[1]["id"].split("-")[0]
    normal = bool(re.search(r"_(?:OSR|OC|RR|R|U|C|P)(?:_\d+)?\.png$", path.name))
    # 元の収録商品の通常版を優先。該当版が複数なら公式一覧の順序を維持する。
    return (path.parent.name not in (prefix, "COMMON"), not normal)


def run_cards(cards, directory=None):
    # 全ページの解釈と重複本文の一致検証を終えてから書き出す。
    for kind, result in cards.items():
        write_json(result, (Path(directory) / (kind + ".json")) if directory else CARD_FILES[kind])
    return cards


def run_images(manifest, directory=None):
    image_dir = Path(directory) if directory else IMAGE_DIR
    # 生成されたカード番号のファイルだけを、この出力先で更新する。
    card_ids = set()
    expected = set()
    for item in manifest:
        match = IMAGE_FILENAME.fullmatch(item["filename"])
        if not match:
            raise ValueError("未知のカード画像ファイル名: " + item["filename"])
        require_official_url(item["url"])
        card_ids.add(match.group(1))
        expected.add(item["filename"])
    image_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    with create_session() as session:
        for item in manifest:
            response = session.get(item["url"], timeout=30)
            response.raise_for_status()
            if "image/png" not in response.headers.get("Content-Type", "") or not response.content.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("PNG画像ではありません: " + item["url"])
            path = image_dir / item["filename"]
            path.write_bytes(response.content)
            saved.append(path)
            print("画像: " + path.name, flush=True)
    # 取得に失敗した場合は旧画像を削除しない。対象外のカードには触れない。
    root = image_dir.resolve()
    for path in image_dir.glob("*.png"):
        match = IMAGE_FILENAME.fullmatch(path.name)
        if match and match.group(1) in card_ids and path.name not in expected:
            if path.resolve().parent != root:
                raise ValueError("画像の削除先が出力フォルダ外です: " + str(path))
            path.unlink()
            print("旧画像を削除: " + path.name, flush=True)
    return saved


def parse_official_deck(soup):
    title = text(soup.select_one("h1"))
    if not title:
        raise ValueError("公式デッキ名がありません")
    groups = {}
    for heading in soup.select(".sec-ttl"):
        label = text(heading)
        key = next((key for prefix, key in [("推しホロメン", "oshi"), ("メインデッキ", "main"), ("エールデッキ", "cheer")] if label.startswith(prefix)), None)
        if key is None:
            continue
        box = heading.find_next_sibling("div", class_="card-box")
        if box is None or key in groups:
            raise ValueError("公式デッキのカード欄を解釈できません: " + label)
        counts = {}
        for item in box.select(".card"):
            image = item.select_one("img[src]")
            match = CARD_NUMBER.match(Path(urlparse(image["src"]).path).name) if image else None
            if not match:
                raise ValueError("公式デッキのカード番号を解釈できません")
            amount = text(item.select_one(".num"))
            if key == "oshi" and not amount:
                n = 1
            else:
                number = re.fullmatch(r"[×x](\d+)", amount)
                if not number or int(number.group(1)) < 1:
                    raise ValueError("公式デッキの枚数を解釈できません: " + amount)
                n = int(number.group(1))
            card_id = match.group(0)
            counts[card_id] = counts.get(card_id, 0) + n
        groups[key] = counts
    if set(groups) != {"oshi", "main", "cheer"} or sum(groups["oshi"].values()) != 1 or sum(groups["main"].values()) != 50 or sum(groups["cheer"].values()) != 20:
        raise ValueError("公式デッキの推し1・メイン50・エール20枚を取得できません: " + title)
    return {"name": title, "oshiId": next(iter(groups["oshi"])), "main": groups["main"], "cheer": groups["cheer"]}


def collect_sample_decks(cards):
    index = {c["id"]: (kind, c) for kind, result in cards.items() for c in result[kind]}
    urls = []
    base = OFFICIAL_ROOT + "/deck/recommend/"
    with create_session() as session:
        first = get_soup(base, session)
        page_numbers = [int(match.group(1)) for a in first.select("a[href]") if (match := re.search(r"/deck/recommend/page/(\d+)/", a["href"]))]
        pages = max([1, *page_numbers])
        for page in range(1, pages + 1):
            soup = first if page == 1 else get_soup(base + f"page/{page}/", session)
            found = [urljoin(OFFICIAL_ROOT, a["href"]) for a in soup.select("a[href]") if re.fullmatch(r"/deck/h[a-z0-9]+[-_]\d{3}/", urlparse(a["href"]).path)]
            if not found:
                raise ValueError("公式おすすめデッキ一覧が空です")
            for url in found:
                if url not in urls:
                    urls.append(url)
        decks = []
        for url in urls:
            deck = parse_official_deck(get_soup(url, session))
            for group, entries, allowed in [("oshi", {deck["oshiId"]: 1}, ("oshi_holomen",)), ("main", deck["main"], ("holomen", "support")), ("cheer", deck["cheer"], ("yell",))]:
                for card_id, n in entries.items():
                    if card_id not in index or index[card_id][0] not in allowed:
                        raise ValueError("公式デッキのカードが取得済みデータと一致しません: " + card_id)
                    if group == "main" and n > 4 and "何枚でも" not in index[card_id][1].get("extra", ""):
                        raise ValueError("公式デッキのカードが4枚を超えています: " + card_id)
            decks.append(deck)
            print("公式デッキ: " + deck["name"], flush=True)
    return decks


def find_back_rectangle(page, label):
    # 表示ラベルの左にある、カード比率のクリッピング枠を取得する。
    labels = page.search_for(label)
    if len(labels) != 1:
        raise ValueError("公式ルールブックの裏面ラベルを解釈できません: " + label)
    anchor = labels[0]
    candidates = {}
    for drawing in page.get_drawings(extended=True):
        rect = drawing.get("scissor")
        if drawing["type"] != "clip" or rect is None or rect.height <= 0:
            continue
        if 0.70 < rect.width / rect.height < 0.73 and rect.width > 50 and rect.x1 < anchor.x0 and rect.y0 <= (anchor.y0 + anchor.y1) / 2 <= rect.y1:
            candidates[tuple(round(v, 2) for v in rect)] = rect
    if len(candidates) != 1:
        raise ValueError("公式ルールブックの裏面範囲を一意に取得できません: " + label)
    return next(iter(candidates.values()))


def run_backs(directory):
    with create_session() as session:
        soup = get_soup(OFFICIAL_ROOT + "/rules/", session)
        links = [urljoin(OFFICIAL_ROOT, a["href"]) for a in soup.select("a[href]") if text(a) == "オフィシャルルールブック"]
        if len(set(links)) != 1:
            raise ValueError("公式ルールブックのURLを一意に取得できません")
        url = links[0]
        require_official_url(url)
        response = session.get(url, timeout=30)
        response.raise_for_status()
        if not response.content.startswith(b"%PDF-"):
            raise ValueError("公式ルールブックがPDFではありません")
    destination = Path(directory)
    destination.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(stream=response.content, filetype="pdf") as document:
        for kind, label in [("holomen", "ホロメンカードの裏面"), ("yell", "エールカードの裏面")]:
            pages = [page for page in document if label in [line.strip() for line in page.get_text().splitlines()]]
            if len(pages) != 1:
                raise ValueError("公式ルールブックの裏面ページを一意に取得できません: " + label)
            page = pages[0]
            rect = find_back_rectangle(page, label)
            # PDF本来の角丸の外側を透明にし、白い矩形背景を付けない。
            page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=rect, alpha=True).save(destination / (kind + "_backside.png"))
            print("公式裏面: " + kind, flush=True)
    return 2


def check_project_child(path):
    path = Path(path)
    if path.is_symlink() or path.resolve().parent != PROJECT_DIR.resolve():
        raise ValueError("dataの置換先がプロジェクト直下ではありません: " + str(path))
    return path


def replace_data_contents(staging, target, backup):
    """data自体を移動できない場合も、失敗時に旧内容を復元して更新する。"""
    backup.mkdir()
    moved_old = []
    moved_new = []
    try:
        for path in sorted(target.iterdir()):
            path.rename(backup / path.name)
            moved_old.append(path.name)
        for path in sorted(staging.iterdir()):
            path.rename(target / path.name)
            moved_new.append(path.name)
    except BaseException:
        for name in reversed(moved_new):
            (target / name).rename(staging / name)
        for name in reversed(moved_old):
            (backup / name).rename(target / name)
        backup.rmdir()
        raise


def publish_data(staging):
    staging = check_project_child(staging)
    target = check_project_child(OUTPUT_DIR)
    if target.name != "data" or not staging.name.startswith(".data-fetch-"):
        raise ValueError("dataの置換対象が不正です")
    backup = check_project_child(Path(tempfile.mkdtemp(prefix=".data-previous-", dir=PROJECT_DIR)))
    backup.rmdir()
    keep_directory = False
    if target.exists():
        try:
            target.rename(backup)
        except PermissionError:
            keep_directory = True
    if keep_directory:
        replace_data_contents(staging, target, backup)
    else:
        try:
            staging.rename(target)
        except BaseException as error:
            if backup.exists():
                backup.rename(target)
            else:
                raise
            if isinstance(error, PermissionError):
                replace_data_contents(staging, target, backup)
            else:
                raise
    if backup.exists():
        check_project_child(backup)
        shutil.rmtree(backup)


def run_pipeline():
    cards, manifest = collect_official_cards()
    with tempfile.TemporaryDirectory(prefix=".data-fetch-", dir=PROJECT_DIR) as temporary:
        staging = check_project_child(Path(temporary))
        run_images(manifest, staging / "card_images")
        decks = collect_sample_decks(cards)
        run_backs(staging / "card_backside_images")
        run_cards(cards, staging)
        write_json(decks, staging / "sample_decks.json")
        # 全取得が成功した時だけ旧dataを丸ごと入れ替える。
        publish_data(staging)
    return {"cards": cards, "images": len(manifest), "backs": 2, "decks": len(decks)}


def main():
    parser = argparse.ArgumentParser(description="公式のカード本文・画像・裏面・おすすめデッキでdata全体を置き換える")
    parser.parse_args()
    result = run_pipeline()
    cards = result["cards"]
    print("完了: " + ", ".join(f"{kind}={len(cards[kind][kind])}" for kind in CARD_TYPES))
    print(f"画像={result['images']}, 裏面={result['backs']}, サンプルデッキ={result['decks']}")


if __name__ == "__main__":
    main()
