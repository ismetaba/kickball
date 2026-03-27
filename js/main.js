// Entry point
const game = new Game();
const ui = new UI(game);
game._ui = ui;
window._game = game;
