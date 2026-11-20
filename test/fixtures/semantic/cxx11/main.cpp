struct Range {
  int values[4];
  int *begin() { return values; }
  int *end() { return values + 4; }
};

static_assert(sizeof(Range) == 16, "four ints");

int main() {
  Range r = {{1, 2, 3, 4}};
  int total = 0;
  auto add = [&total](int v) { total += v; };
  for (auto v : r) {
    add(v);
  }
  auto scale = [](int v) { return v * 2; };
  auto broken = [](int v) { return v * total; };
  decltype(total) copy = total;
  auto a = 1, b = 2.0;
  return scale(copy);
}
