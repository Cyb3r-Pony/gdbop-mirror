# -*- coding: utf-8 -*-
"""Regenerates all news article pages (BG+EN) and the homepage news cards
from content/news/*.json. Run by GitHub Actions on every change."""
import re,glob,os,json
try:
    import markdown as _md
    def md2html(t): return _md.markdown(t or '', extensions=['nl2br'])
except Exception:
    def md2html(t):
        return ''.join('<p>'+p.strip().replace('\n','<br>')+'</p>' for p in (t or '').split('\n\n') if p.strip())

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
CAT={'drugs':('Наркотици','Drugs'),'cyber':('Киберпрестъпност','Cybercrime'),
 'human-trafficking':('Трафик на хора','Human Trafficking'),'organised-crime':('Организирана престъпност','Organised Crime'),
 'counterfeiting':('Фалшификации','Counterfeiting'),'cultural-valuables':('Културни ценности','Cultural Valuables'),
 'financial-fraud':('Финансови измами','Financial Fraud'),'investigation':('Разследване','Investigation'),
 'smuggling':('Контрабанда','Smuggling'),'corruption':('Корупция и изпиране на пари','Corruption and Money Laundering')}
NB=' '
def nbsp(html):
    blocks=[]
    def stash(m): blocks.append(m.group(0)); return '\x00'+str(len(blocks)-1)+'\x00'
    html=re.sub(r'<(script|style)\b.*?</\1>', stash, html, flags=re.S|re.I)
    def fix(m):
        t=m.group(1)
        t=re.sub(r'([0-9Ѐ-ӿ]) (г\.)', r'\1'+NB+r'\2', t)
        for _ in range(2):
            t=re.sub(r'(^|[\s („])([вВсСкКуУиИаАоОяЯ]) (?=[Ѐ-ӿ])', r'\1\2'+NB, t)
        return '>'+t+'<'
    html=re.sub(r'>([^<]+)<', fix, html)
    return re.sub(r'\x00(\d+)\x00', lambda m: blocks[int(m.group(1))], html)

TPL_BG=open('templates/news-article.bg.html',encoding='utf-8').read()
TPL_EN=open('templates/news-article.en.html',encoding='utf-8').read()
def esc(s): return (s or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')
def dispdate(iso):
    y,m,d=iso.split('-'); return f"{d}.{m}.{y}"
def crumb(title): 
    t=title.strip(); return t if len(t)<=44 else t[:42].rstrip()+'…'

def section(a,en):
    date=dispdate(a['date']); tag=CAT.get(a['category'],('',''))[1 if en else 0]
    sub=a.get('subtitle_en' if en else 'subtitle_bg') or a.get('subtitle_bg','')
    bodysrc=a.get('body_en' if en else 'body_bg') or a.get('body_bg','')
    img=os.path.basename(a['image']); imgpath=('../../images/' if en else '../images/')+img
    cap='Photo: GDCOC' if en else 'Снимка: ГДБОП'
    body=md2html(bodysrc)
    parts=['<section class="reveal">',
      f'  <div class="article-meta"><span class="article-date">{date}</span><span class="article-tag">{esc(tag)}</span></div>']
    if sub: parts.append(f'  <h2>{esc(sub)}</h2>')
    parts.append(f'  <div class="figure"><img src="{imgpath}" alt="{cap}" loading="lazy"><div class="cap">{cap}</div></div>')
    parts.append('  '+body)
    if a.get('source_url'):
        lbl='the post ↗' if en else 'публикацията ↗'; pre='Source: ' if en else 'Източник: '
        parts.append(f'  <div class="callout">{pre}<a class="inline" href="{esc(a["source_url"])}" target="_blank" rel="noopener noreferrer">{lbl}</a></div>')
    if a.get('hashtags'):
        tags=[t.strip() for t in a['hashtags'].split(',') if t.strip()]
        parts.append('  <div class="hashtags">'+''.join('<span>#'+esc(t)+'</span>' for t in tags)+'</div>')
    parts.append('</section>')
    return '\n'.join(parts)

def render(a,slug,en):
    tpl=TPL_EN if en else TPL_BG
    title=(a.get('title_en' if en else 'title_bg') or a.get('title_bg',''))
    suffix=' | GDCOC — Ministry of the Interior' if en else ' | ГДБОП — МВР'
    desc=title+('. Read the full news report.' if en else '. Прочетете пълната новина.')
    h=tpl.replace('{{TITLE}}',esc(title)+suffix).replace('{{DESC}}',esc(desc)) \
         .replace('{{SLUG}}',slug).replace('{{BREADCRUMB}}',esc(crumb(title))) \
         .replace('{{H1}}',esc(title)).replace('{{ARTICLE}}',section(a,en))
    return h if en else nbsp(h)

def card(a,slug,en):
    date=dispdate(a['date']); tag=CAT.get(a['category'],('',''))[1 if en else 0]
    title=(a.get('title_en' if en else 'title_bg') or a.get('title_bg',''))
    img=os.path.basename(a['image']); imgp=('../images/' if en else 'images/')+img
    more='Read more' if en else 'Повече'
    return ('      <article class="news-card reveal">\n'
      f'        <div class="news-thumb"><img src="{imgp}" alt=""><span class="news-date">{date}</span></div>\n'
      '        <div class="news-body">\n'
      f'          <span class="news-tag">{esc(tag)}</span>\n'
      f'          <h3>{esc(title)}</h3>\n'
      f'          <a class="news-more" href="novini/{slug}.html">{more}</a>\n'
      '        </div>\n      </article>')

# load all
items=[]
for f in glob.glob('content/news/*.json'):
    a=json.load(open(f,encoding='utf-8')); a['_slug']=os.path.basename(f)[:-5]; items.append(a)
items.sort(key=lambda a:(a['date'],a['_slug']), reverse=True)

# article pages
for a in items:
    open('novini/'+a['_slug']+'.html','w',encoding='utf-8').write(render(a,a['_slug'],False))
    open('en/novini/'+a['_slug']+'.html','w',encoding='utf-8').write(render(a,a['_slug'],True))

# homepage cards between markers
for f,en in [('index.html',False),('en/index.html',True)]:
    s=open(f,encoding='utf-8').read()
    cards='\n'+'\n'.join(card(a,a['_slug'],en) for a in items)+'\n      '
    s2=re.sub(r'(<!-- NEWS:START -->)[\s\S]*?(<!-- NEWS:END -->)', lambda m:m.group(1)+cards+m.group(2), s, count=1)
    if not en: s2=nbsp(s2)
    open(f,'w',encoding='utf-8').write(s2)
print('built',len(items),'news items ->',len(items)*2,'article pages + 2 homepage grids')
