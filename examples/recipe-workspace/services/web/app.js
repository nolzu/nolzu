const API = 'http://localhost:8787/recipes';

function render(recipes) {
  const list = document.getElementById('recipes');
  list.textContent = '';

  for (const recipe of recipes) {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = recipe.title;

    const minutes = document.createElement('span');
    minutes.className = 'minutes';
    minutes.textContent = ` ${recipe.minutes} min`;

    item.append(title, minutes);
    list.append(item);
  }
}

async function load() {
  const status = document.getElementById('status');
  try {
    const response = await fetch(API);
    if (!response.ok) {
      status.textContent = `The api answered ${response.status}. Start it with: node services/api/src/server.ts`;
      return;
    }
    render(await response.json());
    status.textContent = '';
  } catch {
    status.textContent = 'The api is not running. Start it with: node services/api/src/server.ts';
  }
}

load();
