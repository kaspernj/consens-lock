import Routes from "velocious/build/src/routes/index.js";

const routes = new Routes();

routes.draw((route) => {
  route.post("locks/obtain");
  route.post("locks/release");
});

export default { routes };
