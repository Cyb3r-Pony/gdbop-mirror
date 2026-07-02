# -*- coding: utf-8 -*-
import re,glob,os,json,html
TAG2CAT={'Наркотици':'drugs','Киберпрестъпност':'cyber','Трафик на хора':'human-trafficking',
 'Организирана престъпност':'organised-crime','Фалшификации':'counterfeiting','Културни ценности':'cultural-valuables',
 'Финансови измами':'financial-fraud','Разследване':'investigation','Контрабанда':'smuggling',
 'Корупция и изпиране на пари':'corruption'}
def clean(t):
    t=re.sub(r'<[^>]+>','',t); t=html.unescape(t); return t.replace(' ',' ').strip()
def sect(s): 
    m=re.search(r'<section class="reveal">([\s\S]*?)</section>',s); return m.group(1) if m else ''
def field(pat,s,d=''):
    m=re.search(pat,s,re.S); return clean(m.group(1)) if m else d
def body(sec):
    ps=[clean(p) for p in re.findall(r'<p>(.*?)</p>',sec,re.S)]
    return '\n\n'.join(p for p in ps if p)
for bgf in sorted(glob.glob('novini/novina-*.html')):
    slug=os.path.basename(bgf)[:-5]
    enf='en/novini/'+os.path.basename(bgf)
    bg=open(bgf,encoding='utf-8').read(); sb=sect(bg)
    en=open(enf,encoding='utf-8').read() if os.path.exists(enf) else ''; se=sect(en)
    date_disp=field(r'<span class="article-date">([^<]+)</span>',sb)
    d,mo,y=date_disp.split('.'); date_iso=f"{y}-{mo}-{d}"
    tag_bg=field(r'<span class="article-tag">([^<]+)</span>',sb)
    cat=TAG2CAT.get(tag_bg,'organised-crime')
    imgm=re.search(r'<img src="\.\./images/([^"]+)"',sb); image='images/'+(imgm.group(1) if imgm else '')
    src=re.search(r'<div class="callout">.*?href="([^"]+)"',sb,re.S); source_url=src.group(1) if src else ''
    hts=re.findall(r'#([^<#\s]+)',field(r'<div class="hashtags">(.*?)</div>',sb) or '')
    obj=dict(date=date_iso,category=cat,image=image,
      title_bg=field(r'<h1>(.*?)</h1>',bg), title_en=field(r'<h1>(.*?)</h1>',en) if en else '',
      subtitle_bg=field(r'<h2>(.*?)</h2>',sb), subtitle_en=field(r'<h2>(.*?)</h2>',se) if se else '',
      body_bg=body(sb), body_en=body(se) if se else '',
      source_url=source_url, hashtags=', '.join(hts))
    json.dump(obj, open('content/news/'+slug+'.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
    print('migrated',slug,'|',date_iso,cat,'| body_bg chars:',len(obj['body_bg']),'| en:',bool(obj['title_en']))
