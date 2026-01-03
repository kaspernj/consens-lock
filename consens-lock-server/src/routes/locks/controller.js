import Controller from "velocious/build/src/controller.js";
import { obtainLock, releaseLock } from "../../services/lock-service.js";

export default class LocksController extends Controller {
  async obtain() {
    const { name, ownerId } = this.params();

    if (!name || !ownerId) {
      this.renderJsonArg({
        error: "name and ownerId are required",
        status: "error",
      });
      return;
    }

    const result = await obtainLock({ name, ownerId });
    this.renderJsonArg({
      ...result,
      name,
    });
  }

  async release() {
    const { name, ownerId } = this.params();

    if (!name || !ownerId) {
      this.renderJsonArg({
        error: "name and ownerId are required",
        status: "error",
      });
      return;
    }

    const result = await releaseLock({ name, ownerId });
    this.renderJsonArg({
      ...result,
      name,
    });
  }
}
