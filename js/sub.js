if('scrollRestoration' in history) history.scrollRestoration='manual';
(function(){function top(){ if(!location.hash) window.scrollTo({top:0,left:0,behavior:'instant'}); }
addEventListener('load',top); addEventListener('pageshow',function(e){ if(e.persisted) top(); });})();
// shared subpage behavior
const header=document.getElementById('header'),progress=document.getElementById('progress'),toTop=document.getElementById('toTop');
addEventListener('scroll',()=>{
  const y=scrollY,h=document.documentElement.scrollHeight-innerHeight;
  if(progress)progress.style.width=(h?y/h*100:0)+'%';
  if(header)header.classList.toggle('scrolled',y>40);
  if(toTop)toTop.classList.toggle('show',y>700);
},{passive:true});
if(toTop)toTop.onclick=()=>scrollTo({top:0,behavior:'smooth'});

// reveal on scroll
const io=new IntersectionObserver(es=>es.forEach(e=>{
  if(e.isIntersecting){e.target.classList.add('revealed');io.unobserve(e.target)}
}),{threshold:.1});
if('IntersectionObserver' in window){document.querySelectorAll('.reveal').forEach(el=>io.observe(el));}else{document.querySelectorAll('.reveal').forEach(el=>el.classList.add('revealed'));}

// side-nav current section highlight
const secs=[...document.querySelectorAll('.article section[id]')];
const sideLinks=[...document.querySelectorAll('.side-nav a')];
if(secs.length&&sideLinks.length){
  const spy=new IntersectionObserver(es=>es.forEach(e=>{
    if(e.isIntersecting){
      sideLinks.forEach(l=>l.classList.toggle('current',l.getAttribute('href')==='#'+e.target.id));
    }
  }),{rootMargin:'-30% 0px -60% 0px'});
  secs.forEach(s=>spy.observe(s));
}

// accordion
document.querySelectorAll('.acc-item').forEach(item=>{
  const q=item.querySelector('.acc-q'),a=item.querySelector('.acc-a');
  q.setAttribute('aria-expanded','false');
  q.addEventListener('click',()=>{
    const open=item.classList.toggle('open');
    q.setAttribute('aria-expanded',open);
    a.style.maxHeight=open?a.scrollHeight+'px':'0';
  });
});

// keep open accordion panels sized correctly on resize/rotation
let rT;addEventListener('resize',()=>{clearTimeout(rT);rT=setTimeout(()=>{
  document.querySelectorAll('.acc-item.open .acc-a').forEach(a=>a.style.maxHeight=a.scrollHeight+'px');
},150)});

// mobile menu
const burger=document.getElementById('burger'),nav=document.getElementById('nav');
if(burger&&nav){
  const closeMenu=()=>{burger.classList.remove('active');nav.classList.remove('open');document.body.classList.remove('menu-open');burger.setAttribute('aria-expanded','false')};
  burger.setAttribute('aria-expanded','false');
  burger.onclick=()=>{
    const open=burger.classList.toggle('active');
    nav.classList.toggle('open',open);
    document.body.classList.toggle('menu-open',open);
    burger.setAttribute('aria-expanded',open);
    if(!open)nav.querySelectorAll('li.open').forEach(l=>l.classList.remove('open'));
  };
  nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',e=>{
    const li=a.parentElement;
    if(innerWidth<=1060&&li.querySelector&&li.querySelector('.dropdown')){e.preventDefault();const _o=!li.classList.contains('open');nav.querySelectorAll('li.open').forEach(l=>{if(l!==li)l.classList.remove('open')});li.classList.toggle('open',_o);return}
    closeMenu();
  }));
  addEventListener('resize',()=>{if(innerWidth>1060)closeMenu()});
}
