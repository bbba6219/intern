// 漸進式增強：沒有 JS 時所有表單仍可正常送出
(function () {
  // 選了既有組別就清掉「新增組別」，避免兩邊都填
  var sel = document.getElementById('track-select');
  if (sel) {
    var input = document.querySelector('input[name=new_track]');
    if (input) {
      sel.addEventListener('change', function () { if (sel.value) input.value = ''; });
      input.addEventListener('input', function () { if (input.value) sel.value = ''; });
    }
  }

  // 建立計劃：輸入名稱時即時提示既有計劃，避免重複
  var name = document.getElementById('np-name');
  var box = document.getElementById('np-suggest');
  if (name && box) {
    var timer;
    var render = function (items) {
      box.textContent = '';
      if (!items.length) { box.hidden = true; return; }
      var p = document.createElement('div');
      p.textContent = '已存在類似的計劃，是不是同一個？';
      box.appendChild(p);
      var ul = document.createElement('ul');
      items.forEach(function (it) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '/p/' + encodeURIComponent(it.slug);
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = it.name + (it.company ? '（' + it.company + '）' : '');
        li.appendChild(a); ul.appendChild(li);
      });
      box.appendChild(ul);
      box.hidden = false;
    };
    name.addEventListener('input', function () {
      clearTimeout(timer);
      var q = name.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(function () {
        fetch('/api/programs/search?q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); }).then(render).catch(function () {});
      }, 250);
    });
  }
})();
