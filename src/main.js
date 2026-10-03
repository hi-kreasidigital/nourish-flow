// Mobile nav
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('site-nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Instagram Reels: load embed.js only when the section nears the viewport
const reels = document.querySelector('.reels');
if (reels) {
  const load = () => {
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.instagram.com/embed.js';
    document.body.appendChild(s);
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { load(); obs.disconnect(); }
    }, { rootMargin: '300px' }).observe(reels);
  } else {
    load();
  }
}
