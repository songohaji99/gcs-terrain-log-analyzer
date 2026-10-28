"""Bangun panduan pengguna PDF dari dokumentasi Markdown (docs/USER_GUIDE.md + README.md).

    python tools/build_guidebook.py        (atau: npm run docs:pdf)
Keluaran: docs/Chakrawala-Panduan-Pengguna.pdf
Butuh: pip install -r tools/requirements.txt (reportlab, pillow). Font dicari otomatis di Windows/macOS/Linux.
"""
import re
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether, NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Preformatted, Spacer, Table, TableStyle)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "Chakrawala-Panduan-Pengguna.pdf"
SOURCES = [ROOT / "docs" / "USER_GUIDE.md", ROOT / "README.md"]
CREDIT = "Chakrawala · Development by Cakrayuda"

# ---------------------------------------------------------------- font lintas OS
FONT_CANDIDATES = {
    "regular": ["C:/Windows/Fonts/segoeui.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"],
    "bold": ["C:/Windows/Fonts/segoeuib.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"],
    "mono": ["C:/Windows/Fonts/consola.ttf", "/System/Library/Fonts/Supplemental/Courier New.ttf", "/Library/Fonts/Courier New.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"],
}
FALLBACK = {"regular": "Helvetica", "bold": "Helvetica-Bold", "mono": "Courier"}
F = {}
for kind, paths in FONT_CANDIDATES.items():
    path = next((p for p in paths if Path(p).exists()), None)
    if path:
        pdfmetrics.registerFont(TTFont(f"Doc-{kind}", path))
        F[kind] = f"Doc-{kind}"
    else:
        F[kind] = FALLBACK[kind]
UNICODE_OK = F["regular"] != "Helvetica"
if F["regular"].startswith("Doc-"):
    pdfmetrics.registerFontFamily("Doc-regular", normal=F["regular"], bold=F["bold"], italic=F["regular"], boldItalic=F["bold"])


def safe(text):
    """Font bawaan PDF tidak punya glyph panah/≤/≥/≡ — ganti dengan ASCII bila font Unicode tidak ditemukan."""
    if UNICODE_OK:
        return text
    for a, b in {"→": "->", "≤": "<=", "≥": ">=", "≡": "=", "↑": "^", "↓": "v", "—": "-", "–": "-", "·": "-", "≈": "~"}.items():
        text = text.replace(a, b)
    return text


NAVY, INK, MUTED, CYAN, AMBER = (colors.HexColor(c) for c in ("#0b1220", "#1e293b", "#64748b", "#0891b2", "#d97706"))
LINE, SOFT = colors.HexColor("#e2e8f0"), colors.HexColor("#f1f5f9")
W_TEXT = 174 * mm
S = {
    "h1": ParagraphStyle("h1", fontName=F["bold"], fontSize=20, leading=25, textColor=NAVY, spaceAfter=8),
    "h2": ParagraphStyle("h2", fontName=F["bold"], fontSize=14, leading=19, textColor=NAVY, spaceBefore=12, spaceAfter=5),
    "h3": ParagraphStyle("h3", fontName=F["bold"], fontSize=11.5, leading=16, textColor=NAVY, spaceBefore=8, spaceAfter=3),
    "body": ParagraphStyle("body", fontName=F["regular"], fontSize=10, leading=14.5, textColor=INK, spaceAfter=5),
    "li": ParagraphStyle("li", fontName=F["regular"], fontSize=10, leading=14, textColor=INK, leftIndent=14, bulletIndent=3, spaceAfter=2),
    "cell": ParagraphStyle("cell", fontName=F["regular"], fontSize=8.6, leading=11.5, textColor=INK),
    "cellh": ParagraphStyle("cellh", fontName=F["bold"], fontSize=8.6, leading=11.5, textColor=NAVY),
    "cap": ParagraphStyle("cap", fontName=F["regular"], fontSize=8.5, leading=11, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=8),
    "code": ParagraphStyle("code", fontName=F["mono"], fontSize=8.2, leading=11, textColor=colors.HexColor("#e2e8f0")),
}


# ---------------------------------------------------------------- markdown inline
def inline(t):
    t = safe(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"`([^`]+)`", lambda m: f'<font face="{F["mono"]}" color="#0e7490">{m.group(1)}</font>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<font color="#0891b2">\1</font>', t)
    return t


def image(path, caption, width=W_TEXT, keep=True):
    w, h = PILImage.open(path).size
    img = Image(str(path), width=width, height=width * h / w)
    box = Table([[img]], colWidths=[width + 2])
    box.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#cbd5e1")), *[(k, (0, 0), (-1, -1), 0) for k in ("LEFTPADDING", "RIGHTPADDING", "TOPPADDING", "BOTTOMPADDING")]]))
    parts = [box, Paragraph(inline(caption), S["cap"])]
    return KeepTogether(parts) if keep else parts  # di dalam sel tabel KeepTogether tidak bisa diukur


def code_block(text):
    t = Table([[Preformatted(safe(text), S["code"])]], colWidths=[W_TEXT])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), NAVY), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return [Spacer(1, 2), t, Spacer(1, 6)]


def callout(text):
    t = Table([[Paragraph(inline(text), S["cell"])]], colWidths=[W_TEXT])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("LINEBEFORE", (0, 0), (0, -1), 3, AMBER), ("LEFTPADDING", (0, 0), (-1, -1), 9),
                           ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return [t, Spacer(1, 6)]


def md_table(rows):
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows if not re.match(r"^\s*\|?\s*:?-{3,}", r)]
    n = max(len(r) for r in cells)
    widths = [W_TEXT * w for w in ({2: [0.3, 0.7], 3: [0.26, 0.3, 0.44], 4: [0.22, 0.26, 0.26, 0.26]}.get(n) or [1 / n] * n)]
    data = [[Paragraph(inline(c), S["cellh" if i == 0 else "cell"]) for c in r + [""] * (n - len(r))] for i, r in enumerate(cells)]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, LINE), ("BACKGROUND", (0, 0), (-1, 0), SOFT), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]))
    return [t, Spacer(1, 6)]


def html_images(block, base):
    """<table> berisi <img src> + <sub> (galeri README) -> grid 2 kolom."""
    pairs = re.findall(r'<img src="([^"]+)"[^>]*/?>\s*(?:<br/>)?\s*<sub>(.*?)</sub>', block)
    cells = [image(base / src, cap, W_TEXT / 2 - 6, keep=False) for src, cap in pairs if (base / src).exists()]
    rows = [cells[i:i + 2] + [""] * (2 - len(cells[i:i + 2])) for i in range(0, len(cells), 2)]
    if not rows:
        return []
    t = Table(rows, colWidths=[W_TEXT / 2] * 2)
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2)]))
    return [t]


def mermaid_note(src):
    names = [n.replace("<br/>", " ") for n in re.findall(r'\["([^"]+)"\]', src)]
    return [Paragraph(inline("Diagram arsitektur (versi interaktif Mermaid ada di README di GitHub). Komponen:"), S["body"]),
            *[Paragraph(inline(n), S["li"], bulletText="•") for n in names], Spacer(1, 4)]


def convert(md_path, skip_hero=False):
    base = md_path.parent
    lines = md_path.read_text(encoding="utf-8").splitlines()
    out, i, first_h1 = [], 0, True
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if line.startswith("```"):
            lang, body, indent = line[3:].strip(), [], len(raw) - len(raw.lstrip())
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                body.append(lines[i][indent:] if lines[i][:indent].isspace() else lines[i])
                i += 1
            out += mermaid_note("\n".join(body)) if lang == "mermaid" else code_block("\n".join(body))
        elif line.startswith("<table"):
            block = []
            while i < len(lines) and "</table>" not in lines[i]:
                block.append(lines[i])
                i += 1
            out += html_images("\n".join(block), base)
        elif line.startswith("<") or line.startswith("[![") or not line or line == "---":
            pass  # div/komentar/badge eksternal/baris kosong
        elif m := re.match(r"^(#{1,3}) (.+)", line):
            lvl, text = len(m.group(1)), m.group(2)
            if skip_hero and text == "Daftar isi":  # daftar isi README tidak relevan di PDF
                while i + 1 < len(lines) and not lines[i + 1].startswith("## "):
                    i += 1
            elif lvl == 1:
                if skip_hero:
                    text = "Referensi Teknis — " + text
                out += ([] if first_h1 else [PageBreak()]) + [Paragraph(inline(text), S["h1"])]
                first_h1 = False
            else:
                out.append(Paragraph(inline(text), S[f"h{lvl}"]))
        elif m := re.match(r"^!\[([^\]]*)\]\(([^)]+)\)", line):
            p = base / m.group(2)
            if p.exists() and not (skip_hero and "02-flightlog" in m.group(2)):
                out.append(image(p, m.group(1)))
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            out += md_table(rows)
            continue
        elif line.startswith(">"):
            out += callout(line.lstrip("> "))
        elif m := re.match(r"^(\d+)\. (.+)", line):
            out.append(Paragraph(inline(m.group(2)), S["li"], bulletText=f"{m.group(1)}."))
        elif line.startswith("- "):
            out.append(Paragraph(inline(line[2:]), S["li"], bulletText="•"))
        else:
            out.append(Paragraph(inline(line), S["body"]))
        i += 1
    return out


# ---------------------------------------------------------------- halaman
def watermark(c):
    """Watermark tersembunyi: teks tak terlihat (render mode 3) — ikut terekstrak/tercari, tidak tampil."""
    c.saveState()  # mode render teks (Tr 3) tidak boleh bocor ke isi halaman
    t = c.beginText(20 * mm, 5 * mm)
    t.setTextRenderMode(3)
    t.setFont(F["regular"], 6)
    t.textLine(safe(f"{CREDIT} — hak cipta Cakrayuda"))
    t.setTextRenderMode(0)
    c.drawText(t)
    c.restoreState()


def on_cover(c, doc):
    W, H = A4
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    img = ROOT / "docs" / "img" / "02-flightlog.jpg"
    if img.exists():
        iw, ih = PILImage.open(img).size
        w = W - 36 * mm
        c.drawImage(str(img), 18 * mm, H * 0.33, width=w, height=w * ih / iw)
    c.setFillColor(colors.white)
    c.setFont(F["bold"], 34)
    c.drawString(18 * mm, H - 40 * mm, "CHAKRA")
    c.setFillColor(colors.HexColor("#22d3ee"))
    c.drawString(18 * mm + c.stringWidth("CHAKRA", F["bold"], 34), H - 40 * mm, "WALA")
    c.setFillColor(colors.HexColor("#cbd5e1"))
    c.setFont(F["regular"], 14)
    c.drawString(18 * mm, H - 52 * mm, safe("Panduan Pengguna — WebGIS Terpadu, Analisis Misi & Flight Log Drone"))
    c.setFont(F["regular"], 10)
    c.setFillColor(colors.HexColor("#94a3b8"))
    y = H * 0.27
    for line in ("Dihasilkan otomatis dari docs/USER_GUIDE.md dan README.md.",
                 "Semua screenshot memakai data demo SINTETIS — bukan data penerbangan nyata.",
                 "", "Repositori: github.com/songohaji99/gcs-terrain-log-analyzer"):
        c.drawString(18 * mm, y, safe(line))
        y -= 6 * mm
    c.setFillColor(colors.HexColor("#22d3ee"))
    c.rect(18 * mm, 24 * mm, 40 * mm, 1.2 * mm, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#94a3b8"))
    c.setFont(F["regular"], 9.5)
    c.drawString(18 * mm, 16 * mm, safe(CREDIT))
    watermark(c)


def on_page(c, doc):
    W, H = A4
    c.setFillColor(NAVY)
    c.rect(0, H - 12 * mm, W, 12 * mm, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont(F["bold"], 9)
    c.drawString(18 * mm, H - 7.8 * mm, "CHAKRAWALA")
    c.setFillColor(colors.HexColor("#94a3b8"))
    c.setFont(F["regular"], 8.5)
    c.drawRightString(W - 18 * mm, H - 7.8 * mm, "Panduan Pengguna")
    c.setStrokeColor(LINE)
    c.line(18 * mm, 13 * mm, W - 18 * mm, 13 * mm)
    c.setFillColor(MUTED)
    c.drawString(18 * mm, 8.5 * mm, safe(CREDIT))
    c.drawRightString(W - 18 * mm, 8.5 * mm, f"Halaman {doc.page}")
    watermark(c)


def build():
    doc = BaseDocTemplate(str(OUT), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=17 * mm,
                          title="Chakrawala — Panduan Pengguna", author="Development by Cakrayuda", creator=CREDIT,
                          subject="WebGIS terpadu, analisis misi & flight log drone", keywords="Chakrawala, Cakrayuda, WebGIS, ArduPilot, QGroundControl")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    doc.addPageTemplates([PageTemplate("cover", [frame], onPage=on_cover), PageTemplate("page", [frame], onPage=on_page)])
    story = [Spacer(1, 1), NextPageTemplate("page"), PageBreak()]
    story += convert(SOURCES[0])
    story += [PageBreak()] + convert(SOURCES[1], skip_hero=True)
    doc.build(story)
    print("tulis", OUT.relative_to(ROOT), f"{OUT.stat().st_size / 1e6:.1f} MB", "| font:", F["regular"])


if __name__ == "__main__":
    build()
