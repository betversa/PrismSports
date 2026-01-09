type Router = {
  push: (href: string) => void;
};

export function useRouter(): Router {
  return {
    push: (href: string) => {
      if (typeof window === "undefined") return;
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  };
}
