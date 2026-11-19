class Buffer {
  int *data;
  int &count;

public:
  explicit Buffer(int &counter) : data(new int[16]), count(counter) { ++count; }
  Buffer(const Buffer &) = delete;
  ~Buffer() { delete[] data; }
};

struct Point {
  int x, y;
  Point(int px, int py) : x(px), y(py) {}
};

int main() {
  int live = 0;
  Buffer a(live);
  Buffer b = a;
  Buffer c = live;
  Point origin;
  Point p(1, 2);
  return p.x + live;
}
