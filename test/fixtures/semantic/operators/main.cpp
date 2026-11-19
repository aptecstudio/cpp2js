namespace money {
  class Amount {
    long cents;

  public:
    Amount(long c = 0) : cents(c) {}
    Amount operator+(const Amount &other) const { return Amount(cents + other.cents); }
    bool operator<(const Amount &other) const { return cents < other.cents; }
    explicit operator bool() const { return cents != 0; }
    long value() const { return cents; }
  };
}

struct Meters { explicit Meters(double); };
void walk(Meters distance);

int main() {
  money::Amount a(150), b = 250;
  money::Amount total = a + b + 100;
  if (total < a) {
    return 1;
  }
  bool any = total;
  walk(3.5);
  return total.value() - a;
}
