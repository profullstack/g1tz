(async () => {
  const params = new URLSearchParams(location.search);
  const wanted = params.get("plan");
  const org = params.get("org");
  const upgrade = document.getElementById("upgrade");
  if (wanted) {
    upgrade.classList.remove("hidden");
    upgrade.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = `To move ${org ? "organization " + org : "your organization"} to ${wanted[0].toUpperCase()}${wanted.slice(1)}: link its OpenAccess principal, then buy ${location.host}/${wanted} at the hub. The entitlement sets the plan.`;
    upgrade.appendChild(p);
  }
  const response = await fetch("/api/v1/plans");
  const data = await response.json();
  const host = document.getElementById("plans");
  host.innerHTML = "";
  for (const plan of data.plans) {
    const card = document.createElement("div");
    card.className = "card" + (plan.plan === wanted ? " current" : "");
    const h = document.createElement("h3"); h.textContent = plan.name; card.appendChild(h);
    const price = document.createElement("p"); price.className = "muted"; price.textContent = plan.price; card.appendChild(price);
    const seats = document.createElement("p"); seats.textContent = plan.seatCap === null ? "Unlimited seats" : `${plan.seatCap} seat${plan.seatCap === 1 ? "" : "s"}`; card.appendChild(seats);
    const list = document.createElement("ul"); list.className = "plain";
    for (const [key, feature] of Object.entries(data.features)) {
      const unlocked = data.plans.findIndex((p) => p.plan === feature.plan) <= data.plans.findIndex((p) => p.plan === plan.plan);
      if (!unlocked) continue;
      const li = document.createElement("li"); li.textContent = `✓ ${feature.line}`; li.className = "ok"; li.dataset.feature = key; list.appendChild(li);
    }
    if (!list.children.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Everything local, one seat"; list.appendChild(li); }
    card.appendChild(list);
    host.appendChild(card);
  }
})().catch((error) => { document.getElementById("plans").textContent = `Could not load the plans: ${error.message}`; });
