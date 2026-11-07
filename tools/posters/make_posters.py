"""Market posters in the Duxie's design: header from the stall's own artwork,
the rest drawn here so every market gets its own name, date, address and a
working QR that opens that market's order page.

    python3 make_posters.py <header-art.png> <out-dir> [qr.json]

qr.json maps market id -> the app's QR svg (made with web/core/qr.js).
"""
import json, re, sys, datetime
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ART, OUT, QRJ = sys.argv[1], sys.argv[2], sys.argv[3]
F = '/usr/share/fonts/opentype/inter/{}.otf'
font = lambda n, s: ImageFont.truetype(F.format(n), s)
PURPLE, DEEP, CREAM, INK = (112, 30, 110), (78, 18, 78), (252, 246, 236), (60, 22, 62)
W, H = 1080, 1500
BASE = 'https://stallflow.github.io/Stallflow/duxies/'

MARKETS = [
    dict(id='M03', name='Blairegowrie Craft Market', date='2026-11-07', time='9:00 \u2013 15:00',
         venue='Domus Dei Campus', addr='39 Malcolm Road, Blairegowrie, Randburg'),
    dict(id='M05', name='Tin Road Market', date='2026-11-07', time='',
         venue='Bromhof', addr='Randburg'),
    dict(id='M06', name='Fourways Gardens Market', date='2026-11-07', time='',
         venue='Fourways Gardens Estate', addr='Camdeboo Road, Fourways, Sandton'),
    dict(id='M07', name='RNW Roodekrans', date='2026-11-07', time='',
         venue='Roodekrans', addr='Roodepoort'),
    dict(id='M04', name='Caroline Market', date='2027-11-01', time='',
         venue='Lyttelton', addr=''),
    dict(id='home', name='Order any time', date='', time='',
         venue='Between markets', addr='We arrange the collection with you'),
]


def pretty(iso):
    d = datetime.date.fromisoformat(iso)
    return d.strftime('%a ') + str(d.day) + d.strftime(' %b %Y')


def fit(draw, text, name, size, width, minsize=34):
    while size > minsize and draw.textlength(text, font=font(name, size)) > width:
        size -= 2
    return font(name, size)


def wrap(draw, text, f, width):
    lines, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=f) <= width or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    return lines + ([cur] if cur else [])


def qr_img(svg, px):
    n = int(re.search(r'viewBox="0 0 (\d+)', svg).group(1))
    path = re.search(r'<path d="([^"]+)"', svg).group(1)
    im = Image.new('RGB', (n, n), 'white'); d = ImageDraw.Draw(im)
    for x, y, w in re.findall(r'M(\d+) (\d+)h(\d+)v1', path):
        d.rectangle([int(x), int(y), int(x) + int(w) - 1, int(y)], fill=(40, 10, 40))
    return im.resize((px, px), Image.NEAREST)


def pill(im, box, fill=CREAM, r=44, shadow=True):
    if shadow:
        sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([box[0], box[1] + 6, box[2], box[3] + 6], r, fill=(0, 0, 0, 70))
        im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(8)))
    ImageDraw.Draw(im).rounded_rectangle(box, r, fill=fill)


def poster(m, art, svg, path, hits):
    sc = W / art.width
    head = art.crop((0, 0, art.width, 548)).resize((W, int(548 * sc)), Image.LANCZOS)
    # meadow: the artwork's own blurred lower half
    meadow = art.crop((0, 700, art.width, art.height)).resize((W, H - head.height + 160), Image.LANCZOS)
    meadow = meadow.filter(ImageFilter.GaussianBlur(26)).convert('RGBA')
    im = Image.new('RGBA', (W, H), CREAM)
    im.paste(meadow, (0, head.height - 160))
    im.paste(head, (0, 0))
    d = ImageDraw.Draw(im)
    y = head.height - 8

    # name plate
    pill(im, (46, y, W - 46, y + 238), fill=PURPLE, r=50)
    d = ImageDraw.Draw(im)
    d.text((W // 2, y + 46), 'Join us at the' if m['id'] != 'home' else 'Order ahead, any day', font=font('InterDisplay-SemiBoldItalic', 34),
           fill=(240, 214, 240), anchor='mm')
    nm = m['name'] if m['id'] != 'home' else 'Duxie’s order page'
    lines = [nm]
    f = fit(d, nm, 'InterDisplay-BlackItalic', 78, W - 150, 56)
    if d.textlength(nm, font=f) > W - 150:
        lines = wrap(d, nm, f, W - 150)
    for i, ln in enumerate(lines):
        d.text((W // 2, y + 118 + i * 74), ln, font=f, fill='white', anchor='mm')
    if len(lines) == 1:
        d.text((W // 2, y + 190), 'jams   ·   crochet   ·   biscuits   ·   resin',
               font=font('Inter-SemiBold', 26), fill=(240, 214, 240), anchor='mm')
    y += 238 + 22

    # date / time
    if m['date']:
        txt = pretty(m['date']) + ('   |   ' + m['time'] if m['time'] else '')
        pill(im, (66, y, W - 66, y + 92), r=46); d = ImageDraw.Draw(im)
        d.text((W // 2, y + 46), txt, font=fit(d, txt, 'InterDisplay-Bold', 44, W - 190), fill=INK, anchor='mm')
        y += 92 + 18

    # venue + address
    pill(im, (66, y, W - 66, y + 150), r=46); d = ImageDraw.Draw(im)
    d.text((W // 2, y + 46), m['venue'], font=fit(d, m['venue'], 'InterDisplay-ExtraBold', 50, W - 190, 36), fill=PURPLE, anchor='mm')
    af = fit(d, m['addr'], 'Inter-SemiBold', 31, W - 190, 24)
    if m['addr']:
        d.text((W // 2, y + 106), m['addr'], font=af, fill=INK, anchor='mm')
    y += 150 + 18

    # three reasons
    pill(im, (66, y, W - 66, y + 74), fill=(250, 232, 190), r=37); d = ImageDraw.Draw(im)
    d.text((W // 2, y + 37), 'Unique crafts   |   Homemade goodies   |   Perfect gifts',
           font=fit(d, 'Unique crafts   |   Homemade goodies   |   Perfect gifts', 'Inter-SemiBold', 29, W - 170), fill=INK, anchor='mm')
    y += 74 + 22

    # scan to order
    bottom = H - 96
    top = y
    pill(im, (46, top, W - 46, bottom), fill=DEEP, r=50); d = ImageDraw.Draw(im)
    qs = min(bottom - top - 44, 330)
    qx, qy = W - 46 - 28 - qs, top + (bottom - top - qs) // 2
    pill(im, (qx - 14, qy - 14, qx + qs + 14, qy + qs + 14), fill='white', r=26, shadow=False)
    im.paste(qr_img(svg, qs), (qx, qy))
    hits.append((qx - 14, qy - 14, qx + qs + 14, qy + qs + 14))
    tx = 46 + 36
    tw = qx - 14 - 24 - tx
    cy = top + (bottom - top) // 2
    d.text((tx, cy - 70), 'SCAN TO', font=font('InterDisplay-BlackItalic', 50), fill='white', anchor='lm')
    d.text((tx, cy - 14), 'ORDER AHEAD', font=font('InterDisplay-BlackItalic', 50), fill='white', anchor='lm')
    sub = 'Reserve now – pay at the stall.' if m['id'] != 'home' else 'Reserve now – pay when you collect.'
    for i, ln in enumerate(wrap(d, sub, font('Inter-Medium', 30), tw) + ['No app, no account.']):
        d.text((tx, cy + 50 + i * 38), ln, font=font('Inter-Medium', 30), fill=(240, 220, 240), anchor='lm')

    # link
    link = BASE + '?m=' + m['id']
    pill(im, (46, H - 82, W - 46, H - 24), fill=CREAM, r=29); d = ImageDraw.Draw(im)
    hits.append((46, H - 82, W - 46, H - 24))
    d.text((W // 2, H - 53), link, font=fit(d, link, 'Inter-SemiBold', 30, W - 150, 20), fill=PURPLE, anchor='mm')
    im.convert('RGB').save(path, quality=92)


art = Image.open(ART).convert('RGB')
qr = json.load(open(QRJ))
for m in MARKETS:
    p = '%s/Duxies-%s-%s.png' % (OUT, m['id'], re.sub(r'[^a-z0-9]+', '-', m['name'].lower()).strip('-'))
    hits = []
    poster(m, art, qr[m['id']], p, hits); print(p)
    # A picture cannot hold a link; the PDF copy makes the QR and the bar at the foot tap-through.
    from reportlab.pdfgen import canvas
    pdf = p[:-4] + '.pdf'
    c = canvas.Canvas(pdf, pagesize=(W * .75, H * .75))
    c.setTitle(m['name'] + ' \u2013 Duxie\'s Homemade')
    c.drawImage(p, 0, 0, W * .75, H * .75)
    for x0, y0, x1, y1 in hits:
        c.linkURL(BASE + '?m=' + m['id'], (x0 * .75, (H - y1) * .75, x1 * .75, (H - y0) * .75), relative=0, thickness=0)
    c.save(); print(pdf)
