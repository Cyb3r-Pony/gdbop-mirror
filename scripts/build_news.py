# -*- coding: utf-8 -*-
"""Regenerate news article pages (BG+EN) and homepage cards from content/news/*.json.
Input is treated as UNTRUSTED (a non-technical editor edits it via Pages CMS in a
separate repo), so every field is escaped/sanitised before it reaches the HTML."""
import re,glob,os,json

# --- markdown -> sanitised HTML for the article body ---
try:
    import markdown as _md
    _to_html=lambda t:_md.markdown(t or '', extensions=['nl2br'])
except Exception:
    _to_html=lambda t:''.join('<p>'+p.strip().replace('\n','<br>')+'</p>' for p in (t or '').split('\n\n') if p.strip())
ALLOWED_TAGS=['p','br','strong','em','b','i','u','a','ul','ol','li','blockquote','h3','h4','code','pre','hr']
ALLOWED_ATTRS={'a':['href','title','target','rel']}
try:
    import bleach
    def sanitize(h): return bleach.clean(h, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS, protocols=['http','https','mailto'], strip=True)
except Exception:
    def sanitize(h):
        h=re.sub(r'(?is)<(script|style|iframe|object|embed|form|svg|math)[^>]*>.*?</\1>','',h)
        h=re.sub(r'(?is)<\s*/?\s*(script|style|iframe|object|embed|form|svg|math)[^>]*>','',h)
        h=re.sub(r'(?i)\son\w+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)','',h)   # strip on* handlers
        h=re.sub(r'(?i)(href|src)\s*=\s*("|\')\s*javascript:[^"\']*(\2)',r'\1=\2#\2',h)
        return h
def md2html(t): return sanitize(_to_html(t))

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); os.chdir(ROOT)
CAT={'drugs':('Наркотици','Drugs'),'cyber':('Киберпрестъпност','Cybercrime'),
 'human-trafficking':('Трафик на хора','Human Trafficking'),'organised-crime':('Организирана престъпност','Organised Crime'),
 'counterfeiting':('Фалшификации','Counterfeiting'),'cultural-valuables':('Културни ценности','Cultural Valuables'),
 'financial-fraud':('Финансови измами','Financial Fraud'),'investigation':('Разследване','Investigation'),
 'smuggling':('Контрабанда','Smuggling'),'corruption':('Корупция и изпиране на пари','Corruption and Money Laundering')}
NB='\u00a0'
def nbsp(html):
    blocks=[]
    def stash(m): blocks.append(m.group(0)); return '\x00'+str(len(blocks)-1)+'\x00'
    html=re.sub(r'<(script|style)\b.*?</\1>', stash, html, flags=re.S|re.I)
    def fix(m):
        t=m.group(1); t=re.sub(r'([0-9Ѐ-ӿ]) (г\.)', r'\1'+NB+r'\2', t)
        for _ in range(2): t=re.sub(r'(^|[\s („])([вВсСкКуУиИаАоОяЯ]) (?=[Ѐ-ӿ])', r'\1\2'+NB, t)
        return '>'+t+'<'
    html=re.sub(r'>([^<]+)<', fix, html)
    return re.sub(r'\x00(\d+)\x00', lambda m: blocks[int(m.group(1))], html)

def esc(s): return (s or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')
def safe_slug(s): return re.sub(r'[^a-z0-9-]','',(s or '').lower()) or 'news'
def safe_img(s): return re.sub(r'[^A-Za-z0-9._-]','',os.path.basename(s or ''))
def safe_url(s):
    s=(s or '').strip(); return s if re.match(r'^https?://',s) else ''
def dispdate(iso):
    try: y,m,d=iso.split('-'); return f"{int(d):02d}.{int(m):02d}.{y}"
    except Exception: return esc(iso)

TPL_BG=open('templates/news-article.bg.html',encoding='utf-8').read()
TPL_EN=open('templates/news-article.en.html',encoding='utf-8').read()
def crumb(t): t=(t or '').strip(); return t if len(t)<=44 else t[:42].rstrip()+'…'

def section(a,en):
    date=dispdate(a.get('date','')); tag=CAT.get(a.get('category'),('',''))[1 if en else 0]
    sub=a.get('subtitle_en' if en else 'subtitle_bg') or a.get('subtitle_bg','')
    body=md2html(a.get('body_en' if en else 'body_bg') or a.get('body_bg',''))
    img=safe_img(a.get('image','')); imgpath=('../../images/' if en else '../images/')+img
    cap='Photo: GDCOC' if en else 'Снимка: ГДБОП'
    p=['<section class="reveal">',
       f'  <div class="article-meta"><span class="article-date">{esc(date)}</span><span class="article-tag">{esc(tag)}</span></div>']
    if sub: p.append(f'  <h2>{esc(sub)}</h2>')
    if img: p.append(f'  <div class="figure"><img src="{esc(imgpath)}" alt="{cap}" loading="lazy"><div class="cap">{cap}</div></div>')
    p.append('  '+body)
    su=safe_url(a.get('source_url'))
    if su:
        lbl='the post ↗' if en else 'публикацията ↗'; pre='Source: ' if en else 'Източник: '
        p.append(f'  <div class="callout">{pre}<a class="inline" href="{esc(su)}" target="_blank" rel="noopener noreferrer">{lbl}</a></div>')
    if a.get('hashtags'):
        tags=[re.sub(r'[^\w]','',t.strip()) for t in str(a['hashtags']).split(',') if t.strip()]
        tags=[t for t in tags if t]
        if tags: p.append('  <div class="hashtags">'+''.join('<span>#'+esc(t)+'</span>' for t in tags)+'</div>')
    p.append('</section>'); return '\n'.join(p)

def render(a,slug,en):
    tpl=TPL_EN if en else TPL_BG
    title=(a.get('title_en' if en else 'title_bg') or a.get('title_bg',''))
    suffix=' | GDCOC — Ministry of the Interior' if en else ' | ГДБОП — МВР'
    desc=title+('. Read the full news report.' if en else '. Прочетете пълната новина.')
    h=tpl.replace('{{TITLE}}',esc(title)+suffix).replace('{{DESC}}',esc(desc)).replace('{{SLUG}}',slug)\
         .replace('{{BREADCRUMB}}',esc(crumb(title))).replace('{{H1}}',esc(title)).replace('{{ARTICLE}}',section(a,en))
    return h if en else nbsp(h)

def card(a,slug,en):
    date=dispdate(a.get('date','')); tag=CAT.get(a.get('category'),('',''))[1 if en else 0]
    title=(a.get('title_en' if en else 'title_bg') or a.get('title_bg',''))
    imgp=('../images/' if en else 'images/')+safe_img(a.get('image',''))
    more='Read more' if en else 'Повече'
    return ('      <article class="news-card reveal">\n'
      f'        <div class="news-thumb"><img src="{esc(imgp)}" alt=""><span class="news-date">{esc(date)}</span></div>\n'
      '        <div class="news-body">\n'
      f'          <span class="news-tag">{esc(tag)}</span>\n'
      f'          <h3>{esc(title)}</h3>\n'
      f'          <a class="news-more" href="news/{slug}.html">{more}</a>\n'
      '        </div>\n      </article>')

def card_list(a,slug,en):
    date=dispdate(a.get('date','')); tag=CAT.get(a.get('category'),('',''))[1 if en else 0]
    title=(a.get('title_en' if en else 'title_bg') or a.get('title_bg',''))
    imgp=('../../images/' if en else '../images/')+safe_img(a.get('image',''))
    return ('      <a class="news-card reveal" href="'+esc(slug)+'.html">\n'
      f'        <div class="news-thumb"><img src="{esc(imgp)}" alt=""><span class="news-date">{esc(date)}</span></div>\n'
      '        <div class="news-body">\n'
      f'          <span class="news-tag">{esc(tag)}</span>\n'
      f'          <h3>{esc(title)}</h3>\n'
      '        </div>\n      </a>')

def render_list(en):
    tpl=TPL_EN if en else TPL_BG
    title='News' if en else 'Новини'; home='Home' if en else 'Начало'
    suffix=' | GDCOC — Ministry of the Interior' if en else ' | ГДБОП — МВР'
    desc='Latest news and operations from GDCOC.' if en else 'Актуални новини и операции от ГДБОП — МВР.'
    grid='<div class="news-grid">\n'+'\n'.join(card_list(a,a['_slug'],en) for a in items)+'\n    </div>'
    h=tpl.replace('{{TITLE}}',esc(title)+suffix).replace('{{DESC}}',esc(desc)).replace('{{SLUG}}','index').replace('{{H1}}',title).replace('{{ARTICLE}}',grid)
    h=re.sub(r'<div class="breadcrumb">.*?</div>', '<div class="breadcrumb"><a href="../index.html">'+home+'</a> → <span>'+title+'</span></div>', h, count=1)
    return h if en else nbsp(h)

items=[]
for f in glob.glob('content/news/*.json'):
    try: a=json.load(open(f,encoding='utf-8'))
    except Exception as e: print('SKIP bad json',f,e); continue
    if not a.get('title_bg') or not a.get('date'): print('SKIP missing title/date',f); continue
    a['_slug']=safe_slug(os.path.basename(f)[:-5]); items.append(a)
items.sort(key=lambda a:(a.get('date',''),a['_slug']), reverse=True)

# regenerate article pages fresh (remove stale ones first)
valid={a['_slug'] for a in items}
for d in ['news','en/news']:
    for h in glob.glob(d+'/*.html'):
        b=os.path.basename(h)[:-5]
        if b!='index' and b not in valid: os.remove(h); print('removed stale',h)
for a in items:
    open('news/'+a['_slug']+'.html','w',encoding='utf-8').write(render(a,a['_slug'],False))
    open('en/news/'+a['_slug']+'.html','w',encoding='utf-8').write(render(a,a['_slug'],True))
open('news/index.html','w',encoding='utf-8').write(render_list(False))
open('en/news/index.html','w',encoding='utf-8').write(render_list(True))
print('built',len(items),'items + 2 listing pages')

# regenerate sitemap.xml so newly added news articles are always included
sm=['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for hf in sorted(glob.glob('**/*.html',recursive=True)):
    if hf.startswith('templates/') or hf=='404.html': continue
    path=hf[:-10] if hf.endswith('index.html') else hf
    sm.append('  <url><loc>https://gdbop.bg/'+path+'</loc></url>')
sm.append('</urlset>')
open('sitemap.xml','w',encoding='utf-8').write('\n'.join(sm)+'\n')
print('sitemap.xml:',len(sm)-3,'urls')
