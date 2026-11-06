"""StallFlow video guide, step 2 of 2: turns guide.js recordings into
captioned phone-shaped MP4s (needs ffmpeg with libx264, Pillow, the Inter font).

    python3 tools/guide/make_video.py            every chapter + the full guide
    python3 tools/guide/make_video.py 01-till    one chapter

Chapters (and a poster picture for each) go to web/guide/, which the app
shows under More › How-to videos. The full guide, for sending on WhatsApp,
goes to tools/guide/out/.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REC, FULL, TMP = (os.path.join(HERE, d) for d in ('rec', 'out', 'tmp'))
OUT = os.path.join(HERE, '..', '..', 'web', 'guide')
for d in (OUT, FULL, TMP):
    os.makedirs(d, exist_ok=True)

W, H = 1080, 1920
BERRY, DEEP, PAPER = (123, 45, 67), (86, 28, 46), (252, 248, 244)
PX, PY, PW, PH, RAD = 140, 236, 800, 1362, 46          # the phone screen on the canvas
CAP_Y = PY + PH + 34                                   # captions start here
FONT = '/usr/share/fonts/opentype/inter/Inter-{}.otf'
font = lambda w, s: ImageFont.truetype(FONT.format(w), s)


def wrap(draw, text, f, width):
    lines, line = [], ''
    for word in text.split():
        test = (line + ' ' + word).strip()
        if draw.textlength(test, font=f) <= width or not line:
            line = test
        else:
            lines.append(line); line = word
    if line:
        lines.append(line)
    return lines


def background(title, path):
    im = Image.new('RGB', (W, H), BERRY)
    d = ImageDraw.Draw(im)
    # a soft darker glow at the foot, where the captions sit
    for i in range(400):
        a = i / 400
        c = tuple(int(BERRY[k] * (1 - a) + DEEP[k] * a) for k in range(3))
        d.line([(0, H - 400 + i), (W, H - 400 + i)], fill=c)
    d.text((W // 2, 78), "STALLFLOW GUIDE  ·  DUXIE'S HOMEMADE", font=font('SemiBold', 30),
           fill=(240, 214, 222), anchor='mm')
    d.text((W // 2, 150), title, font=font('Bold', 60), fill='white', anchor='mm')
    # the phone: shadow, then a dark rim around the screen
    sh = Image.new('L', (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle([PX - 10, PY + 6, PX + PW + 10, PY + PH + 26], RAD + 12, fill=150)
    sh = sh.filter(ImageFilter.GaussianBlur(22))
    im.paste((40, 12, 22), (0, 0), sh)
    ImageDraw.Draw(im).rounded_rectangle([PX - 12, PY - 12, PX + PW + 12, PY + PH + 12], RAD + 12, fill=(24, 18, 20))
    im.save(path)


def mask(path):
    m = Image.new('L', (PW, PH), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, PW - 1, PH - 1], RAD, fill=255)
    m.save(path)


def caption(text, path):
    im = Image.new('RGBA', (W, H - CAP_Y), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = font('SemiBold', 50)
    lines = wrap(d, text, f, W - 120)
    lh = 64
    y = max(8, (H - CAP_Y - 40 - lh * len(lines)) // 2)
    for i, ln in enumerate(lines):
        d.text((W // 2, y + i * lh + lh // 2), ln, font=f, fill='white', anchor='mm')
    im.save(path)


def card(lines, path):
    """A still: list of (text, weight, size, colour, y)."""
    im = Image.new('RGB', (W, H), BERRY)
    d = ImageDraw.Draw(im)
    for text, weight, size, colour, y in lines:
        f = font(weight, size)
        for i, ln in enumerate(wrap(d, text, f, W - 160)):
            d.text((W // 2, y + i * int(size * 1.3)), ln, font=f, fill=colour, anchor='mm')
    im.save(path)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-2500:]); raise SystemExit('ffmpeg failed')


ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
       '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart']


def still(png, seconds, out):
    run(['ffmpeg', '-y', '-loop', '1', '-t', str(seconds), '-i', png,
         '-f', 'lavfi', '-t', str(seconds), '-i', 'anullsrc=r=44100:cl=stereo',
         '-vf', 'fade=t=in:st=0:d=0.4,fade=t=out:st=%.2f:d=0.4' % (seconds - 0.4), '-shortest'] + ENC + [out])


def chapter(cid):
    src = os.path.join(REC, cid)
    meta = json.load(open(os.path.join(src, 'meta.json')))
    frames, caps, end = meta['frames'], meta['caps'], meta['end']
    start = max(0, (caps[0]['t'] if caps else 0) - 600)      # skip the moment before the first caption
    frames = [f for f in frames if f['t'] >= start] or frames[-1:]
    lst = os.path.join(TMP, cid + '.txt')
    with open(lst, 'w') as fh:
        for i, f in enumerate(frames):
            nxt = frames[i + 1]['t'] if i + 1 < len(frames) else end
            fh.write("file '%s'\nduration %.3f\n" % (os.path.join(src, f['f']), max(0.02, (nxt - f['t']) / 1000)))
        fh.write("file '%s'\n" % os.path.join(src, frames[-1]['f']))
    total = (end - start) / 1000
    bg, mk = os.path.join(TMP, cid + '-bg.png'), os.path.join(TMP, 'mask.png')
    background(meta['title'], bg); mask(mk)
    inputs = ['-loop', '1', '-t', '%.2f' % total, '-i', bg, '-f', 'concat', '-safe', '0', '-i', lst,
              '-loop', '1', '-i', mk]
    flt = ['[1:v]fps=30,scale=%d:%d:flags=lanczos,format=rgba[ph]' % (PW, PH),
           '[2:v]format=gray,scale=%d:%d[mk]' % (PW, PH),
           '[ph][mk]alphamerge[phm]',
           '[0:v][phm]overlay=%d:%d:shortest=1[v0]' % (PX, PY)]
    last = 'v0'
    for i, c in enumerate(caps):
        a = max(0, (c['t'] - start) / 1000)
        b = ((caps[i + 1]['t'] - start) / 1000) if i + 1 < len(caps) else total
        if b - a < 0.3:
            continue
        png = os.path.join(TMP, '%s-cap%02d.png' % (cid, i))
        caption(c['text'], png)
        n = 3 + i
        inputs += ['-loop', '1', '-t', '%.2f' % (b - a), '-i', png]
        flt.append('[%d:v]format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=%.2f:d=0.18:alpha=1,'
                   'setpts=PTS+%.3f/TB[c%d]' % (n, max(0, b - a - 0.18), a, i))
        flt.append('[%s][c%d]overlay=0:%d:eof_action=pass[v%d]' % (last, i, CAP_Y, i + 1))
        last = 'v%d' % (i + 1)
    flt.append('[%s]fade=t=in:st=0:d=0.3,fade=t=out:st=%.2f:d=0.3[out]' % (last, total - 0.3))
    inputs += ['-f', 'lavfi', '-t', '%.2f' % total, '-i', 'anullsrc=r=44100:cl=stereo']
    out = os.path.join(OUT, cid + '.mp4')
    run(['ffmpeg', '-y'] + inputs + ['-filter_complex', ';'.join(flt), '-map', '[out]',
         '-map', '%d:a' % (3 + len(caps)), '-t', '%.2f' % total] + ENC + [out])
    # the picture shown before the video plays: a moment from the middle
    poster = os.path.join(OUT, cid + '.jpg')
    run(['ffmpeg', '-y', '-ss', '%.2f' % (total * 0.45), '-i', out, '-frames:v', '1',
         '-vf', 'scale=540:-1', '-q:v', '5', poster])
    print(cid, '%.1fs' % total, out)
    return out


def full(parts):
    intro, outro = os.path.join(TMP, 'intro.png'), os.path.join(TMP, 'outro.png')
    titles = [json.load(open(os.path.join(REC, c, 'meta.json')))['title'] for c in parts]
    card([("DUXIE'S HOMEMADE", 'SemiBold', 34, (240, 214, 222), 520),
          ('StallFlow', 'Bold', 110, 'white', 640),
          ('How to use the app', 'SemiBold', 56, 'white', 770)] +
         [(t, 'Medium', 42, (246, 230, 236), 960 + i * 66) for i, t in enumerate(titles)], intro)
    card([('That is the app.', 'Bold', 72, 'white', 760),
          ('Something not working? More › Report a problem.', 'SemiBold', 48, 'white', 900),
          ('Open it in Safari or Chrome, then Add to Home Screen.', 'Medium', 40, (246, 230, 236), 1080)], outro)
    still(intro, 6, os.path.join(TMP, 'intro.mp4'))
    still(outro, 4.5, os.path.join(TMP, 'outro.mp4'))
    lst = os.path.join(TMP, 'full.txt')
    with open(lst, 'w') as fh:
        for p in [os.path.join(TMP, 'intro.mp4')] + [os.path.join(OUT, c + '.mp4') for c in parts] + [os.path.join(TMP, 'outro.mp4')]:
            fh.write("file '%s'\n" % p)
    out = os.path.join(FULL, 'StallFlow guide - full.mp4')
    run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', out])
    print('full guide', out)


if __name__ == '__main__':
    chs = sorted(d for d in os.listdir(REC) if os.path.exists(os.path.join(REC, d, 'meta.json')))
    pick = sys.argv[1:] or chs
    for c in pick:
        chapter(c)
    if not sys.argv[1:]:
        full(chs)
