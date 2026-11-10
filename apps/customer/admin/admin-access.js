(() => {
  const API = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
  const LOGIN_HREF = "../?account=login&return_to=admin";
  const ROLE_SETUP_HREF = "https://github.com/fadiu007-creator/Sjelle/blob/main/supabase/operations/first-admin.sql";
  const SQL_EDITOR_HREF = "https://supabase.com/dashboard/project/saavqlbwffrwxingbnri/sql/new";
  const $ = selector => document.querySelector(selector);
  let needsRoleRetry = false;

  function setControlsEnabled(enabled) {
    for (const control of document.querySelectorAll("main form input, main form select, main form textarea, main form button, #admin-city")) control.disabled = !enabled;
  }

  function appendLoginLink(root) {
    if (!root || root.querySelector("a[data-admin-login]")) return;
    const link = document.createElement("a");
    link.href = LOGIN_HREF;
    link.className = "primary-button";
    link.dataset.adminLogin = "true";
    link.textContent = "Kyçu si administrator";
    root.append(link);
  }

  function showLoginRequired() {
    setControlsEnabled(false);
    const alert = $("#admin-alert");
    if (alert) {
      alert.replaceChildren(document.createTextNode("Ky panel është vetëm për administratorët. Kyçu për të parë aplikimet dhe menaxhimin e Sjelle. "));
      appendLoginLink(alert);
      alert.dataset.kind = "warning";
    }
    for (const selector of ["#driver-queue", "#admin-restaurants", "#admin-support-tickets"]) {
      const root = $(selector);
      if (!root) continue;
      root.replaceChildren(Object.assign(document.createElement("p"), { className: "portal-muted", textContent: "Kyçu me llogarinë e administratorit për të ngarkuar këtë listë." }));
      appendLoginLink(root);
    }
  }

  function appendRoleSetupLinks(root) {
    if (!root || root.querySelector("[data-admin-sql-editor]")) return;
    const note = document.createElement("p");
    note.className = "portal-muted";
    note.textContent = "Llogaria është kyçur, por nuk ka rolin admin në sjelle_user_roles. Roli nuk jepet automatikisht. Për administratorin e parë, zëvendëso placeholder-in me email-in e saktë të llogarisë së konfirmuar në SQL dhe ekzekutoje vetëm nga pronari i projektit.";
    const script = document.createElement("a");
    script.href = ROLE_SETUP_HREF;
    script.target = "_blank";
    script.rel = "noopener noreferrer";
    script.textContent = "Hap first-admin.sql";
    note.append(" ", script, " · ");
    const editor = document.createElement("a");
    editor.href = SQL_EDITOR_HREF;
    editor.target = "_blank";
    editor.rel = "noopener noreferrer";
    editor.dataset.adminSqlEditor = "true";
    editor.textContent = "Hap Supabase SQL Editor";
    note.append(editor);
    root.append(note);
  }

  // The backend remains authoritative. This wrapper only keeps the admin UI locked
  // until the existing /admin/cities authorization check succeeds.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const requestUrl = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (requestUrl.startsWith(API + "/admin/")) {
      if (response.status === 401) {
        setControlsEnabled(false);
        showLoginRequired();
      } else if (response.status === 403) {
        needsRoleRetry = true;
        setControlsEnabled(false);
      } else if (response.ok && new URL(requestUrl).pathname.endsWith("/admin/cities")) {
        needsRoleRetry = false;
        setControlsEnabled(true);
      }
    }
    return response;
  };

  setControlsEnabled(false);
  try {
    const session = JSON.parse(sessionStorage.getItem("sjelle.session") || "null");
    if (!session?.access_token) showLoginRequired();
  } catch {
    showLoginRequired();
  }

  const observer = new MutationObserver(() => {
    const alert = $("#admin-alert");
    if (alert && /nuk ka rolin admin/i.test(alert.textContent)) appendRoleSetupLinks(alert);
    for (const selector of ["#driver-queue", "#admin-restaurants", "#admin-support-tickets"]) {
      const root = $(selector);
      if (root && /nuk ka rolin admin/i.test(root.textContent)) appendRoleSetupLinks(root);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && needsRoleRetry) window.location.reload();
  });
})();
