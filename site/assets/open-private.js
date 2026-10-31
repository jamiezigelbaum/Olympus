// A fragment never reaches the website server. It is only a local Inbox handle.
(() => {
  const handle = location.hash.slice(1);
  const link = 'olympus://open/private' + (/^[A-Za-z0-9_-]{22}$/.test(handle) ? '/' + handle : '');
  document.querySelector('.cta a').href = link;
  location.replace(link);
})();
