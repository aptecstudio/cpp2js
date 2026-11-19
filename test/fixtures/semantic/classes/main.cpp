class Account {
  double balance = 0;

public:
  double get() const { return balance; }
  void deposit(double amount);
  void reset() const { balance = 0; }
};

void Account::deposit(double amount) { balance += amount; }

struct Pair {
  char tag;
  double value;
};

int main() {
  Account a;
  a.deposit(10);
  a.balance = 5;
  Pair p = {'x', 1.5};
  int sizes[sizeof(Pair) == 16 ? 1 : -1];
  return a.get() > p.value;
}
