class Registry {
  static int instances;
  int id;
  friend int idOf(const Registry &r);

public:
  static const int limit = 4;
  Registry() : id(++instances) {}
  static int count() { return instances; }
};

int Registry::instances = 0;

int idOf(const Registry &r) { return r.id; }

int stolen(const Registry &r) { return r.id; }

int main() {
  Registry slots[Registry::limit];
  return Registry::count() + idOf(slots[0]) + Registry::instances;
}
