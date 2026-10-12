// The pretend build's page side (see extras-test.cs): the "xtest" switch says On or Off, has a Flip button in place
// of its graph, and remembers the host's last "x.state"
EXT.kinds.xtest = {
  eval(out, r) { out.txt = r.v ? 'On' : 'Off'; out.utxt = ''; out.sub = 'a test switch'; return true; },
  body(cid, r, where) { return '<button class="btn xflip" data-where="' + where + '">Flip</button>'; },
  update(root, r) { const b = root.querySelector('.xflip'); if (b) b.classList.toggle('on', !!r.v); },
  desc() { return 'A pretend switch from the test build.'; },
  detail(box, cid, r, e, full) { if (full) box.innerHTML = '<div class="xdet"></div><button class="btn xflip" data-where="popup">Flip</button>'; box.firstChild.textContent = 'detail ' + (r.v ? 'on' : 'off'); }
};
EXT.msg = m => { if (m.t === 'x.state') window.xLast = m; };
document.addEventListener('click', e => { if (e.target.closest('.xflip') && !S.edit) send({ t: 'x.flip' }); });
window.xLoaded = true;
